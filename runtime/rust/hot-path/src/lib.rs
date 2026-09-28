//! CQ Hot-Path WASM Module
//!
//! High-performance string operations compiled to WebAssembly.
//! Used for token counting helpers and string hashing at >10M ops/sec.
//!
//! Build: wasm-pack build --target nodejs

use wasm_bindgen::prelude::*;
use sha2::{Sha256, Digest};

/// Compute SHA-256 hash of the input string, returned as hex.
#[wasm_bindgen]
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    hex::encode(result)
}

// TODO: Add hot-path string operations as needed (Phase 2+)
