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

//! The few primitives sign-in needs: random tokens, SHA-256, HMAC, base64url.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
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
    getrandom::getrandom(&mut buf).expect("the platform has a CSPRNG");
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

/// Seals an object for R2 under a repository's key (AES-256-GCM). The nonce is
/// derived from the key and the object's address: one address is one
/// plaintext, so a nonce never meets two plaintexts.
pub fn seal(key: &[u8], address: &[u8], plaintext: &[u8]) -> Vec<u8> {
    use aes_gcm::aead::{Aead, KeyInit};
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).expect("a 32-byte key");
    let nonce = sha256(&[key, address].concat());
    cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce[..12]), plaintext)
        .expect("encryption does not fail")
}

/// Opens what `seal` sealed; None when the key or the bytes are wrong.
pub fn open(key: &[u8], address: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).ok()?;
    let nonce = sha256(&[key, address].concat());
    cipher
        .decrypt(aes_gcm::Nonce::from_slice(&nonce[..12]), sealed)
        .ok()
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).expect("the platform has a CSPRNG");
    buf
}
