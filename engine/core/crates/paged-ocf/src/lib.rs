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

//! The OCF package writer (IDML, `.paged`): the container convention every
//! package the engine writes from scratch follows. The `mimetype` entry is
//! the first, stored, with the bytes given (no trailing newline); every
//! other part is deflated, or stored when it is already compressed media;
//! every timestamp is the zip epoch (1980-01-01), so equal parts give equal
//! bytes.
//!
//! A rewrite of an existing package that raw-copies the source's entries
//! (`idml-export`) keeps the source's layout instead and does not use this.

use std::io::{Cursor, Write};

use zip::result::ZipResult;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::{CompressionMethod, DateTime};

pub use zip::result::ZipError;

/// An OCF package being written.
pub struct OcfZip {
    zip: ZipWriter<Cursor<Vec<u8>>>,
    stored: SimpleFileOptions,
    deflated: SimpleFileOptions,
}

impl OcfZip {
    /// A package whose first entry is `mimetype`, stored.
    pub fn new(mimetype: &[u8]) -> ZipResult<Self> {
        let mut out = Self::bare();
        out.stored("mimetype", mimetype)?;
        Ok(out)
    }

    /// A package with no `mimetype` entry yet: the caller writes it first
    /// when it has one (a repository tree may lack it).
    pub fn bare() -> Self {
        let opts = SimpleFileOptions::default().last_modified_time(DateTime::default());
        OcfZip {
            zip: ZipWriter::new(Cursor::new(Vec::new())),
            stored: opts.compression_method(CompressionMethod::Stored),
            deflated: opts.compression_method(CompressionMethod::Deflated),
        }
    }

    /// Add a part, deflated.
    pub fn deflated(&mut self, name: &str, bytes: &[u8]) -> ZipResult<()> {
        self.zip.start_file(name, self.deflated)?;
        self.zip.write_all(bytes)?;
        Ok(())
    }

    /// Add a part, stored (media that is already compressed).
    pub fn stored(&mut self, name: &str, bytes: &[u8]) -> ZipResult<()> {
        self.zip.start_file(name, self.stored)?;
        self.zip.write_all(bytes)?;
        Ok(())
    }

    /// Add a part, stored when `stored` and deflated otherwise.
    pub fn put(&mut self, name: &str, bytes: &[u8], stored: bool) -> ZipResult<()> {
        if stored {
            self.stored(name, bytes)
        } else {
            self.deflated(name, bytes)
        }
    }

    /// The package's bytes.
    pub fn finish(self) -> ZipResult<Vec<u8>> {
        Ok(self.zip.finish()?.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mimetype_comes_first_and_stored() {
        let mut z = OcfZip::new(b"application/x-test").unwrap();
        z.deflated("a.xml", b"<a/>").unwrap();
        let bytes = z.finish().unwrap();
        // The first local header: stored (method 0), named `mimetype`, its
        // bytes at offset 38, where a sniffer reads them.
        assert_eq!(&bytes[8..10], &[0, 0]);
        assert_eq!(&bytes[30..38], b"mimetype");
        assert_eq!(&bytes[38..56], b"application/x-test");
    }
}
