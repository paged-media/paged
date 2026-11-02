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

/// SHA-512 of `data` (the `sha2` crate; the known-vector test below holds it
/// to FIPS 180-4).
pub fn sha512(data: &[u8]) -> [u8; 64] {
    use sha2::{Digest, Sha512};
    Sha512::digest(data).into()
}

// ── base64 (RFC 4648, padded) ────────────────────────────────────────────

use base64::alphabet::STANDARD as ALPHABET;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine as _;

/// Standard alphabet, padded on write; reading takes any padding and any
/// trailing bits, as Excel's files carry them.
const B64: GeneralPurpose = GeneralPurpose::new(
    &ALPHABET,
    GeneralPurposeConfig::new()
        .with_encode_padding(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

pub fn base64_encode(data: &[u8]) -> String {
    B64.encode(data)
}

/// The bytes of `s`; whitespace is skipped, `None` on a character outside
/// the alphabet.
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    B64.decode(clean).ok()
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
