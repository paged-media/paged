/*
 * This file is part of paged (https://paged.media): paged.server, the optional
 * remote for paged repositories.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! The few primitives sign-in and storage need: random tokens, SHA-256, HMAC,
//! base64url, and sealing bytes at rest.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

/// `n` random bytes from the platform's CSPRNG, base64url.
pub fn random(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("the platform has a CSPRNG");
    b64(&buf)
}

pub fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

pub fn sha256_hex(data: &[u8]) -> String {
    sha256(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// PKCE S256: base64url(SHA-256(verifier)).
pub fn s256(verifier: &str) -> String {
    b64(&sha256(verifier.as_bytes()))
}

pub fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("any key length");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

/// Constant-time check of an HMAC.
pub fn hmac_ok(key: &[u8], data: &[u8], tag: &[u8]) -> bool {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("any key length");
    m.update(data);
    m.verify_slice(tag).is_ok()
}

/// Standard (padded) base64, as a model writes it.
pub fn unb64_std(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .ok()
}

/// The first byte of everything `seal` writes. A sealed object is
/// `version ‖ nonce (12 bytes) ‖ ciphertext and tag`.
const SEAL_V1: u8 = 1;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// Seals bytes for R2 under a key (AES-256-GCM) with a fresh random nonce,
/// stored in front of the ciphertext. The address is authenticated with the
/// ciphertext, so bytes sealed for one address do not open at another. The
/// same address may be sealed any number of times: a working copy is.
///
/// A random 96-bit nonce bounds one key to about 2^32 seals; a repository's
/// key and a run's key stay far below that.
pub fn seal(key: &[u8], address: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).expect("the platform has a CSPRNG");
    seal_with(key, address, plaintext, &nonce)
}

fn seal_with(key: &[u8], address: &[u8], plaintext: &[u8], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    use aes_gcm::aead::{Aead, Payload};
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).expect("a 32-byte key");
    let body = cipher
        .encrypt(
            &gcm_nonce(nonce),
            Payload {
                msg: plaintext,
                aad: address,
            },
        )
        .expect("encryption does not fail");
    let mut out = Vec::with_capacity(1 + NONCE_LEN + body.len());
    out.push(SEAL_V1);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&body);
    out
}

/// Opens what `seal` sealed; None when the key, the address, the format
/// version or the bytes are wrong.
pub fn open(key: &[u8], address: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, Payload};
    let (version, rest) = sealed.split_first()?;
    if *version != SEAL_V1 || rest.len() < NONCE_LEN + TAG_LEN {
        return None;
    }
    let (nonce, body) = rest.split_at(NONCE_LEN);
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).ok()?;
    cipher
        .decrypt(
            &gcm_nonce(nonce.try_into().ok()?),
            Payload {
                msg: body,
                aad: address,
            },
        )
        .ok()
}

fn gcm_nonce(bytes: &[u8; NONCE_LEN]) -> aes_gcm::aead::Nonce<aes_gcm::Aes256Gcm> {
    aes_gcm::aead::Nonce::<aes_gcm::Aes256Gcm>::try_from(&bytes[..])
        .expect("an AES-GCM nonce is 12 bytes")
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("the platform has a CSPRNG");
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];

    fn nonce_of(sealed: &[u8]) -> &[u8] {
        &sealed[1..1 + NONCE_LEN]
    }

    #[test]
    fn a_sealed_object_opens_to_what_was_sealed() {
        let sealed = seal(&KEY, b"address", b"the working copy");
        assert_eq!(sealed[0], SEAL_V1);
        assert_eq!(
            sealed.len(),
            1 + NONCE_LEN + b"the working copy".len() + TAG_LEN
        );
        assert_eq!(
            open(&KEY, b"address", &sealed).as_deref(),
            Some(&b"the working copy"[..])
        );
        let empty = seal(&KEY, b"address", b"");
        assert_eq!(open(&KEY, b"address", &empty).as_deref(), Some(&b""[..]));
    }

    #[test]
    fn two_seals_at_one_address_use_different_nonces() {
        let first = seal(&KEY, b"run", b"version one");
        let second = seal(&KEY, b"run", b"version two");
        assert_ne!(nonce_of(&first), nonce_of(&second));
        // The same plaintext sealed twice differs too.
        let again = seal(&KEY, b"run", b"version one");
        assert_ne!(nonce_of(&first), nonce_of(&again));
        assert_ne!(first, again);
        assert_eq!(
            open(&KEY, b"run", &second).as_deref(),
            Some(&b"version two"[..])
        );
    }

    #[test]
    fn the_nonce_stored_is_the_nonce_used() {
        let nonce = [9u8; NONCE_LEN];
        let sealed = seal_with(&KEY, b"a", b"bytes", &nonce);
        assert_eq!(nonce_of(&sealed), &nonce);
        assert_eq!(open(&KEY, b"a", &sealed).as_deref(), Some(&b"bytes"[..]));
    }

    #[test]
    fn a_changed_byte_anywhere_does_not_open() {
        let sealed = seal(&KEY, b"address", b"some bytes worth keeping");
        for i in 0..sealed.len() {
            let mut bad = sealed.clone();
            bad[i] ^= 1;
            assert!(open(&KEY, b"address", &bad).is_none(), "byte {i}");
        }
    }

    #[test]
    fn another_key_address_or_version_does_not_open() {
        let sealed = seal(&KEY, b"address", b"bytes");
        assert!(open(&[8; 32], b"address", &sealed).is_none());
        assert!(open(&KEY, b"elsewhere", &sealed).is_none());
        assert!(open(&KEY[..16], b"address", &sealed).is_none());
        let mut later = sealed.clone();
        later[0] = 2;
        assert!(open(&KEY, b"address", &later).is_none());
        // Bytes without the version and nonce in front are not a sealed object.
        assert!(open(&KEY, b"address", &sealed[1 + NONCE_LEN..]).is_none());
        assert!(open(&KEY, b"address", &sealed[..NONCE_LEN]).is_none());
        assert!(open(&KEY, b"address", &[]).is_none());
    }

    #[test]
    fn an_hmac_checks_out_only_for_its_key_and_data() {
        let tag = hmac(b"key", b"data");
        assert!(hmac_ok(b"key", b"data", &tag));
        assert!(!hmac_ok(b"other", b"data", &tag));
        assert!(!hmac_ok(b"key", b"datum", &tag));
        assert!(!hmac_ok(b"key", b"data", &tag[..tag.len() - 1]));
    }

    #[test]
    fn pkce_s256_is_the_base64url_of_the_sha256() {
        // SHA-256("abc"), the FIPS 180-2 example.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(s256("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    }
}
