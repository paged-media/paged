/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! Sheet and workbook protection (ECMA-376 §18.3.1.85 `sheetProtection`,
//! §18.2.29 `workbookProtection`; sheet ADR 517). The element is read into
//! [`SheetProtection`] / [`WorkbookProtection`], authored back from them, and
//! a password is checked against the hash the file stores:
//!
//! - the agile form (`algorithmName="SHA-512"`, `hashValue`, `saltValue`,
//!   `spinCount`): H0 = SHA-512(salt ‖ password as UTF-16LE), then
//!   Hn = SHA-512(Hn-1 ‖ n as a little-endian u32) for n in 0..spinCount
//!   (ECMA-376 Part 1 §18.2.29 attributes; MS-OFFCRYPTO §2.3.7.1);
//! - the legacy 16-bit form (`password="CBEB"`, ECMA-376 Part 4 §14.7.1).
//!
//! Protection is not encryption: it only stops an edit through the UI. The
//! engine enforces it the way Excel does — locked cells refuse an entry,
//! the `allow*` flags gate formatting, inserting, deleting, sorting and
//! filtering — and never pretends it secures anything.

use crate::xtree::XNode;

/// What a protected sheet still lets a user do, plus the password hash.
/// The `allow_*` booleans are the UI meaning; the XML stores most of them
/// inverted (`formatCells="0"` allows formatting).
#[derive(Clone, Debug, PartialEq)]
pub struct SheetProtection {
    /// `sheet="1"`: the protection is on. An element with `sheet="0"` keeps
    /// its settings but protects nothing.
    pub on: bool,
    pub hash: PasswordHash,
    pub objects: bool,
    pub scenarios: bool,
    pub allow_format_cells: bool,
    pub allow_format_columns: bool,
    pub allow_format_rows: bool,
    pub allow_insert_columns: bool,
    pub allow_insert_rows: bool,
    pub allow_insert_hyperlinks: bool,
    pub allow_delete_columns: bool,
    pub allow_delete_rows: bool,
    pub allow_select_locked: bool,
    pub allow_select_unlocked: bool,
    pub allow_sort: bool,
    pub allow_auto_filter: bool,
    pub allow_pivot_tables: bool,
}

impl Default for SheetProtection {
    /// Excel's "Protect Sheet" defaults: select locked and unlocked cells,
    /// nothing else.
    fn default() -> Self {
        SheetProtection {
            on: true,
            hash: PasswordHash::None,
            objects: false,
            scenarios: false,
            allow_format_cells: false,
            allow_format_columns: false,
            allow_format_rows: false,
            allow_insert_columns: false,
            allow_insert_rows: false,
            allow_insert_hyperlinks: false,
            allow_delete_columns: false,
            allow_delete_rows: false,
            allow_select_locked: true,
            allow_select_unlocked: true,
            allow_sort: false,
            allow_auto_filter: false,
            allow_pivot_tables: false,
        }
    }
}

/// The password a protection element stores.
#[derive(Clone, Debug, PartialEq)]
pub enum PasswordHash {
    None,
    /// The legacy 16-bit hash, as four hex digits.
    Legacy(String),
    /// The agile hash: algorithm name, base64 hash, base64 salt, spin count.
    Agile {
        algorithm: String,
        hash: String,
        salt: String,
        spin: u32,
    },
}

impl PasswordHash {
    /// Whether `password` opens this hash. No hash: any password (Excel
    /// unprotects a sheet without a password on the click). An algorithm
    /// other than SHA-512 cannot be checked and refuses every password.
    pub fn verify(&self, password: &str) -> bool {
        match self {
            PasswordHash::None => true,
            PasswordHash::Legacy(h) => u16::from_str_radix(h.trim(), 16)
                .map(|v| v == legacy_hash(password))
                .unwrap_or(false),
            PasswordHash::Agile {
                algorithm,
                hash,
                salt,
                spin,
            } => {
                if !algorithm.eq_ignore_ascii_case("SHA-512") {
                    return false;
                }
                let Some(salt) = base64_decode(salt) else {
                    return false;
                };
                let Some(want) = base64_decode(hash) else {
                    return false;
                };
                agile_hash(password, &salt, *spin).as_slice() == want.as_slice()
            }
        }
    }

    /// The agile SHA-512 hash of `password` with `salt` (Excel's default
    /// spin count is 100,000). An empty password stores no hash.
    pub fn new_agile(password: &str, salt: &[u8], spin: u32) -> PasswordHash {
        if password.is_empty() {
            return PasswordHash::None;
        }
        PasswordHash::Agile {
            algorithm: "SHA-512".into(),
            hash: base64_encode(&agile_hash(password, salt, spin)),
            salt: base64_encode(salt),
            spin,
        }
    }

    fn read(n: &XNode, prefix: &str) -> PasswordHash {
        let a = |k: &str| n.attr(&hash_key(prefix, k));
        if let (Some(algorithm), Some(hash), Some(salt)) =
            (a("AlgorithmName"), a("HashValue"), a("SaltValue"))
        {
            let spin = a("SpinCount")
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            return PasswordHash::Agile {
                algorithm,
                hash,
                salt,
                spin,
            };
        }
        match a("Password") {
            Some(h) if !h.trim().is_empty() => PasswordHash::Legacy(h),
            _ => PasswordHash::None,
        }
    }

    fn write(&self, n: &mut XNode, prefix: &str) {
        let key = |k: &str| hash_key(prefix, k);
        for k in ["AlgorithmName", "HashValue", "SaltValue", "SpinCount"] {
            n.set(&key(k), None);
        }
        n.set(&key("Password"), None);
        match self {
            PasswordHash::None => {}
            PasswordHash::Legacy(h) => n.set(&key("Password"), Some(h.clone())),
            PasswordHash::Agile {
                algorithm,
                hash,
                salt,
                spin,
            } => {
                n.set(&key("AlgorithmName"), Some(algorithm.clone()));
                n.set(&key("HashValue"), Some(hash.clone()));
                n.set(&key("SaltValue"), Some(salt.clone()));
                n.set(&key("SpinCount"), Some(spin.to_string()));
            }
        }
    }
}

/// A hash attribute's name: `algorithmName` on a sheet, `workbookAlgorithmName`
/// on the workbook (`prefix` = `"workbook"`).
fn hash_key(prefix: &str, k: &str) -> String {
    if prefix.is_empty() {
        let mut c = k.chars();
        match c.next() {
            Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
            None => String::new(),
        }
    } else {
        format!("{prefix}{k}")
    }
}

/// The flag attributes of `sheetProtection`, in schema order, with the
/// default each has when absent (`true` = the action is PROTECTED).
const SHEET_FLAGS: &[(&str, bool)] = &[
    ("sheet", false),
    ("objects", false),
    ("scenarios", false),
    ("formatCells", true),
    ("formatColumns", true),
    ("formatRows", true),
    ("insertColumns", true),
    ("insertRows", true),
    ("insertHyperlinks", true),
    ("deleteColumns", true),
    ("deleteRows", true),
    ("selectLockedCells", false),
    ("sort", true),
    ("autoFilter", true),
    ("pivotTables", true),
    ("selectUnlockedCells", false),
];

impl SheetProtection {
    /// Read a `<sheetProtection>` element.
    pub fn parse(xml: &[u8]) -> Option<SheetProtection> {
        let n = XNode::parse(xml).ok()?;
        if n.local() != "sheetProtection" {
            return None;
        }
        let f = |k: &str| {
            let d = SHEET_FLAGS
                .iter()
                .find(|(n, _)| *n == k)
                .is_some_and(|x| x.1);
            n.flag(k, d)
        };
        Some(SheetProtection {
            on: f("sheet"),
            hash: PasswordHash::read(&n, ""),
            objects: f("objects"),
            scenarios: f("scenarios"),
            allow_format_cells: !f("formatCells"),
            allow_format_columns: !f("formatColumns"),
            allow_format_rows: !f("formatRows"),
            allow_insert_columns: !f("insertColumns"),
            allow_insert_rows: !f("insertRows"),
            allow_insert_hyperlinks: !f("insertHyperlinks"),
            allow_delete_columns: !f("deleteColumns"),
            allow_delete_rows: !f("deleteRows"),
            allow_select_locked: !f("selectLockedCells"),
            allow_select_unlocked: !f("selectUnlockedCells"),
            allow_sort: !f("sort"),
            allow_auto_filter: !f("autoFilter"),
            allow_pivot_tables: !f("pivotTables"),
        })
    }

    /// The element, written as Excel writes it: the hash first, then only
    /// the flags that differ from their defaults.
    pub fn to_xml(&self, prefix: &str) -> String {
        let mut n = XNode::new(format!("{prefix}sheetProtection"));
        self.hash.write(&mut n, "");
        let vals: [(&str, bool); 16] = [
            ("sheet", self.on),
            ("objects", self.objects),
            ("scenarios", self.scenarios),
            ("formatCells", !self.allow_format_cells),
            ("formatColumns", !self.allow_format_columns),
            ("formatRows", !self.allow_format_rows),
            ("insertColumns", !self.allow_insert_columns),
            ("insertRows", !self.allow_insert_rows),
            ("insertHyperlinks", !self.allow_insert_hyperlinks),
            ("deleteColumns", !self.allow_delete_columns),
            ("deleteRows", !self.allow_delete_rows),
            ("selectLockedCells", !self.allow_select_locked),
            ("sort", !self.allow_sort),
            ("autoFilter", !self.allow_auto_filter),
            ("pivotTables", !self.allow_pivot_tables),
            ("selectUnlockedCells", !self.allow_select_unlocked),
        ];
        for ((k, v), (_, d)) in vals.iter().zip(SHEET_FLAGS) {
            if v != d {
                n.attrs
                    .push((k.to_string(), if *v { "1" } else { "0" }.to_string()));
            }
        }
        n.to_xml()
    }
}

/// `<workbookProtection>`: the structure (sheets cannot be added, deleted,
/// renamed, moved, hidden or unhidden) and the window lock.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkbookProtection {
    pub lock_structure: bool,
    pub lock_windows: bool,
    pub hash: PasswordHash,
}

impl WorkbookProtection {
    pub fn parse(xml: &[u8]) -> Option<WorkbookProtection> {
        let n = XNode::parse(xml).ok()?;
        if n.local() != "workbookProtection" {
            return None;
        }
        Some(WorkbookProtection {
            lock_structure: n.flag("lockStructure", false),
            lock_windows: n.flag("lockWindows", false),
            hash: PasswordHash::read(&n, "workbook"),
        })
    }

    pub fn to_xml(&self, prefix: &str) -> String {
        let mut n = XNode::new(format!("{prefix}workbookProtection"));
        self.hash.write(&mut n, "workbook");
        if self.lock_structure {
            n.set("lockStructure", Some("1".into()));
        }
        if self.lock_windows {
            n.set("lockWindows", Some("1".into()));
        }
        n.to_xml()
    }
}

/// The legacy 16-bit password hash (ECMA-376 Part 4 §14.7.1): each
/// character's low byte, rotated in from the last character to the first.
pub fn legacy_hash(password: &str) -> u16 {
    let bytes: Vec<u16> = password.encode_utf16().map(|c| c & 0xFF).collect();
    let mut h: u16 = 0;
    for &b in bytes.iter().rev() {
        h = ((h >> 14) & 0x01) | ((h << 1) & 0x7FFF);
        h ^= b;
    }
    h = ((h >> 14) & 0x01) | ((h << 1) & 0x7FFF);
    h ^= bytes.len() as u16;
    h ^= 0xCE4B;
    h
}

/// The agile iterated SHA-512 hash (see the module docs).
pub fn agile_hash(password: &str, salt: &[u8], spin: u32) -> [u8; 64] {
    let mut buf = salt.to_vec();
    for u in password.encode_utf16() {
        buf.extend_from_slice(&u.to_le_bytes());
    }
    let mut h = sha512(&buf);
    let mut step = [0u8; 68];
    for i in 0..spin {
        step[..64].copy_from_slice(&h);
        step[64..].copy_from_slice(&i.to_le_bytes());
        h = sha512(&step);
    }
    h
}

// ── SHA-512 (FIPS 180-4) ─────────────────────────────────────────────────

const K512: [u64; 80] = [
    0x428a2f98d728ae22,
    0x7137449123ef65cd,
    0xb5c0fbcfec4d3b2f,
    0xe9b5dba58189dbbc,
    0x3956c25bf348b538,
    0x59f111f1b605d019,
    0x923f82a4af194f9b,
    0xab1c5ed5da6d8118,
    0xd807aa98a3030242,
    0x12835b0145706fbe,
    0x243185be4ee4b28c,
    0x550c7dc3d5ffb4e2,
    0x72be5d74f27b896f,
    0x80deb1fe3b1696b1,
    0x9bdc06a725c71235,
    0xc19bf174cf692694,
    0xe49b69c19ef14ad2,
    0xefbe4786384f25e3,
    0x0fc19dc68b8cd5b5,
    0x240ca1cc77ac9c65,
    0x2de92c6f592b0275,
    0x4a7484aa6ea6e483,
    0x5cb0a9dcbd41fbd4,
    0x76f988da831153b5,
    0x983e5152ee66dfab,
    0xa831c66d2db43210,
    0xb00327c898fb213f,
    0xbf597fc7beef0ee4,
    0xc6e00bf33da88fc2,
    0xd5a79147930aa725,
    0x06ca6351e003826f,
    0x142929670a0e6e70,
    0x27b70a8546d22ffc,
    0x2e1b21385c26c926,
    0x4d2c6dfc5ac42aed,
    0x53380d139d95b3df,
    0x650a73548baf63de,
    0x766a0abb3c77b2a8,
    0x81c2c92e47edaee6,
    0x92722c851482353b,
    0xa2bfe8a14cf10364,
    0xa81a664bbc423001,
    0xc24b8b70d0f89791,
    0xc76c51a30654be30,
    0xd192e819d6ef5218,
    0xd69906245565a910,
    0xf40e35855771202a,
    0x106aa07032bbd1b8,
    0x19a4c116b8d2d0c8,
    0x1e376c085141ab53,
    0x2748774cdf8eeb99,
    0x34b0bcb5e19b48a8,
    0x391c0cb3c5c95a63,
    0x4ed8aa4ae3418acb,
    0x5b9cca4f7763e373,
    0x682e6ff3d6b2b8a3,
    0x748f82ee5defb2fc,
    0x78a5636f43172f60,
    0x84c87814a1f0ab72,
    0x8cc702081a6439ec,
    0x90befffa23631e28,
    0xa4506cebde82bde9,
    0xbef9a3f7b2c67915,
    0xc67178f2e372532b,
    0xca273eceea26619c,
    0xd186b8c721c0c207,
    0xeada7dd6cde0eb1e,
    0xf57d4f7fee6ed178,
    0x06f067aa72176fba,
    0x0a637dc5a2c898a6,
    0x113f9804bef90dae,
    0x1b710b35131c471b,
    0x28db77f523047d84,
    0x32caab7b40c72493,
    0x3c9ebe0a15c9bebc,
    0x431d67c49c100d4c,
    0x4cc5d4becb3e42b6,
    0x597f299cfc657e2a,
    0x5fcb6fab3ad6faec,
    0x6c44198c4a475817,
];

/// SHA-512 of `data`.
pub fn sha512(data: &[u8]) -> [u8; 64] {
    let mut h: [u64; 8] = [
        0x6a09e667f3bcc908,
        0xbb67ae8584caa73b,
        0x3c6ef372fe94f82b,
        0xa54ff53a5f1d36f1,
        0x510e527fade682d1,
        0x9b05688c2b3e6c1f,
        0x1f83d9abfb41bd6b,
        0x5be0cd19137e2179,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u128) * 8;
    msg.push(0x80);
    while msg.len() % 128 != 112 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    let mut w = [0u64; 80];
    for block in msg.as_chunks::<128>().0 {
        for (i, wi) in w.iter_mut().take(16).enumerate() {
            let mut b = [0u8; 8];
            b.copy_from_slice(&block[i * 8..i * 8 + 8]);
            *wi = u64::from_be_bytes(b);
        }
        for i in 16..80 {
            let s0 = w[i - 15].rotate_right(1) ^ w[i - 15].rotate_right(8) ^ (w[i - 15] >> 7);
            let s1 = w[i - 2].rotate_right(19) ^ w[i - 2].rotate_right(61) ^ (w[i - 2] >> 6);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..80 {
            let s1 = e.rotate_right(14) ^ e.rotate_right(18) ^ e.rotate_right(41);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K512[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(28) ^ a.rotate_right(34) ^ a.rotate_right(39);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 64];
    for (i, v) in h.iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&v.to_be_bytes());
    }
    out
}

// ── base64 (RFC 4648, padded) ────────────────────────────────────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn sha512_known_vectors() {
        assert_eq!(
            hex(&sha512(b"abc")),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
        assert_eq!(
            hex(&sha512(b"")),
            "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
        );
        // Two blocks.
        let long = b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
        assert_eq!(
            hex(&sha512(long)),
            "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909"
        );
    }

    #[test]
    fn base64_round_trip() {
        for s in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(base64_decode(&base64_encode(s)).unwrap(), s);
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
    }

    #[test]
    fn agile_hash_verifies_its_own_password__feat__sheet_protect_sheet() {
        let h = PasswordHash::new_agile("secret", b"0123456789abcdef", 1000);
        assert!(h.verify("secret"));
        assert!(!h.verify("Secret"));
        assert!(PasswordHash::None.verify("anything"));
    }

    #[test]
    fn legacy_hash_verifies__feat__sheet_protect_sheet() {
        // Values Excel writes for these passwords.
        assert_eq!(legacy_hash("test"), 0xCBEB);
        assert_eq!(legacy_hash("password"), 0x83AF);
        let h = format!("{:04X}", legacy_hash("test"));
        assert!(PasswordHash::Legacy(h.clone()).verify("test"));
        assert!(!PasswordHash::Legacy(h).verify("tess"));
    }

    #[test]
    fn sheet_protection_round_trips_flags__feat__sheet_protect_sheet() {
        let x = br#"<sheetProtection algorithmName="SHA-512" hashValue="aGFzaA==" saltValue="c2FsdA==" spinCount="100000" sheet="1" objects="1" scenarios="1" formatCells="0" sort="0"/>"#;
        let p = SheetProtection::parse(x).unwrap();
        assert!(p.on && p.objects && p.allow_format_cells && p.allow_sort);
        assert!(!p.allow_insert_rows && p.allow_select_locked);
        assert_eq!(p.to_xml("").as_bytes(), &x[..]);
        let back = SheetProtection::parse(p.to_xml("").as_bytes()).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn workbook_protection_round_trips__feat__sheet_protect_workbook() {
        let w = WorkbookProtection {
            lock_structure: true,
            lock_windows: false,
            hash: PasswordHash::new_agile("pw", b"saltsaltsaltsalt", 10),
        };
        let x = w.to_xml("");
        assert!(x.contains("workbookAlgorithmName=\"SHA-512\""));
        let back = WorkbookProtection::parse(x.as_bytes()).unwrap();
        assert_eq!(back, w);
        assert!(back.hash.verify("pw"));
    }
}
