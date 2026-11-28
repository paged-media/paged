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

//! Bounded reading of a zip package's entries.
//!
//! An entry's header may CLAIM any uncompressed size, and a few kilobytes
//! of deflate can inflate to gigabytes, so a package is never read on
//! trust: the declared size is only a capped allocation hint, every entry
//! is read through a limit, and the whole read is held to a total. Past a
//! limit the read stops with a [`BudgetError`]; it never panics and never
//! allocates what the limits do not allow. The IDML reader and the writer
//! (which re-reads the source package) share this one implementation.

use std::io::Read;

/// The uncompressed bytes one package read will hold in total (1 GiB). A
/// wasm32 host could not hold more beside the package itself.
pub const MAX_UNCOMPRESSED_BYTES: u64 = 1 << 30;

/// The uncompressed bytes one entry may hold (512 MiB).
pub const MAX_ENTRY_BYTES: u64 = 512 << 20;

/// The number of entries a package may list. InDesign writes one part per
/// story and spread; the largest documents measured stay in the low
/// thousands.
pub const MAX_ENTRIES: usize = 65_536;

/// Largest pre-allocation made from an entry's DECLARED size; growth past
/// it follows the bytes actually inflated.
const PREALLOC_CAP: u64 = 8 << 20;

/// Deflate's best case is a little over 1000:1, so an entry cannot hold
/// more than this many bytes per byte of package.
const MAX_INFLATION: u64 = 1032;

/// What one package read may hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadLimits {
    /// Uncompressed bytes of one entry.
    pub entry_bytes: u64,
    /// Uncompressed bytes of all entries read.
    pub total_bytes: u64,
    /// Entries the package may list.
    pub entries: usize,
}

impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            entry_bytes: MAX_ENTRY_BYTES,
            total_bytes: MAX_UNCOMPRESSED_BYTES,
            entries: MAX_ENTRIES,
        }
    }
}

/// A package that asks for more than the [`ReadLimits`] allow.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BudgetError {
    #[error("the package lists {count} entries, past the limit of {limit}")]
    TooManyEntries { count: usize, limit: usize },
    #[error(
        "the package's entries declare {declared} uncompressed bytes, past the limit of {limit}"
    )]
    DeclaredTooLarge { declared: u64, limit: u64 },
    #[error("entry {name} holds more than the {limit} uncompressed bytes one entry may")]
    EntryTooLarge { name: String, limit: u64 },
    #[error("the package holds more than {limit} uncompressed bytes (reached at entry {name})")]
    TotalTooLarge { name: String, limit: u64 },
}

/// The running account of one package read.
#[derive(Debug, Clone)]
pub struct ReadBudget {
    limits: ReadLimits,
    remaining: u64,
    /// The package's own length, which bounds what an entry can inflate to.
    package_len: u64,
}

impl ReadBudget {
    /// A budget for reading `archive` under `limits`. Refuses a package
    /// that lists too many entries, or whose entries already DECLARE more
    /// than the total, before anything is inflated.
    pub fn open<R: Read + std::io::Seek>(
        archive: &zip::ZipArchive<R>,
        package_len: u64,
        limits: ReadLimits,
    ) -> Result<Self, BudgetError> {
        if archive.len() > limits.entries {
            return Err(BudgetError::TooManyEntries {
                count: archive.len(),
                limit: limits.entries,
            });
        }
        if let Some(declared) = archive.decompressed_size() {
            if declared > u128::from(limits.total_bytes) {
                return Err(BudgetError::DeclaredTooLarge {
                    declared: u64::try_from(declared).unwrap_or(u64::MAX),
                    limit: limits.total_bytes,
                });
            }
        }
        Ok(Self {
            limits,
            remaining: limits.total_bytes,
            package_len,
        })
    }

    /// A budget for one entry read on its own (the writer fetching a
    /// single part by name): the default per-entry limit, nothing known
    /// of the package around it.
    pub fn for_entry() -> Self {
        let limits = ReadLimits::default();
        Self {
            limits,
            remaining: limits.total_bytes,
            package_len: u64::MAX,
        }
    }

    /// Read one entry to its end, charging its bytes to the budget.
    /// `declared` is the size the entry's header claims: a hint for the
    /// allocation only.
    pub fn read<E>(&mut self, name: &str, declared: u64, entry: impl Read) -> Result<Vec<u8>, E>
    where
        E: From<std::io::Error> + From<BudgetError>,
    {
        let allowed = self.limits.entry_bytes.min(self.remaining);
        let hint = declared
            .min(allowed)
            .min(PREALLOC_CAP)
            .min(self.package_len.saturating_mul(MAX_INFLATION));
        // `hint` is at most `PREALLOC_CAP`, so it fits a `usize` anywhere.
        let mut data = Vec::with_capacity(hint as usize);
        // One byte past what is allowed: reaching it means the entry (or
        // the package) is larger than the limits.
        entry
            .take(allowed.saturating_add(1))
            .read_to_end(&mut data)?;
        let len = data.len() as u64;
        if len > allowed {
            return Err(if allowed == self.limits.entry_bytes {
                BudgetError::EntryTooLarge {
                    name: name.to_string(),
                    limit: self.limits.entry_bytes,
                }
            } else {
                BudgetError::TotalTooLarge {
                    name: name.to_string(),
                    limit: self.limits.total_bytes,
                }
            }
            .into());
        }
        self.remaining -= len;
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    enum TestError {
        Io,
        Budget(BudgetError),
    }
    impl From<std::io::Error> for TestError {
        fn from(_: std::io::Error) -> Self {
            TestError::Io
        }
    }
    impl From<BudgetError> for TestError {
        fn from(e: BudgetError) -> Self {
            TestError::Budget(e)
        }
    }

    fn budget(entry_bytes: u64, total_bytes: u64) -> ReadBudget {
        let limits = ReadLimits {
            entry_bytes,
            total_bytes,
            entries: MAX_ENTRIES,
        };
        ReadBudget {
            limits,
            remaining: total_bytes,
            package_len: 1 << 20,
        }
    }

    #[test]
    fn a_declared_size_is_never_the_allocation() {
        // A claim of `u64::MAX` bytes: allocating it would abort.
        let data: Vec<u8> = budget(1 << 20, 1 << 20)
            .read::<TestError>("a", u64::MAX, &b"abc"[..])
            .expect("reads");
        assert_eq!(data, b"abc");
        assert!(data.capacity() <= PREALLOC_CAP as usize);
    }

    #[test]
    fn an_endless_entry_stops_at_the_entry_limit() {
        let err = budget(1024, 1 << 20)
            .read::<TestError>("a", 3, std::io::repeat(0))
            .unwrap_err();
        assert!(
            matches!(
                &err,
                TestError::Budget(BudgetError::EntryTooLarge { limit: 1024, .. })
            ),
            "{err:?}"
        );
    }

    #[test]
    fn entries_are_charged_to_the_total() {
        let mut b = budget(1024, 1500);
        let part = [0u8; 1000];
        b.read::<TestError>("a", 1000, &part[..])
            .expect("first fits");
        let err = b.read::<TestError>("b", 1000, &part[..]).unwrap_err();
        assert!(
            matches!(
                &err,
                TestError::Budget(BudgetError::TotalTooLarge { limit: 1500, .. })
            ),
            "{err:?}"
        );
        // What is left can still be read.
        assert_eq!(
            b.read::<TestError>("c", 500, &part[..500])
                .expect("fits")
                .len(),
            500
        );
    }

    #[test]
    fn an_entry_of_exactly_the_limit_is_read() {
        let part = [7u8; 1024];
        let data = budget(1024, 1024)
            .read::<TestError>("a", 1024, &part[..])
            .expect("fits");
        assert_eq!(data.len(), 1024);
    }
}
