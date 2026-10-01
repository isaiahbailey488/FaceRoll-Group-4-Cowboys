"""Authenticated encryption for local FaceRoll enrollment records."""

from __future__ import annotations

import base64
import binascii
import json
import os
from pathlib import Path
from typing import Any, Mapping

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .errors import StorageError


ENCRYPTED_FORMAT = "faceroll-enrollment"
ENCRYPTED_VERSION = 1
ENCRYPTION_ALGORITHM = "AES-256-GCM"
KEY_BYTES = 32
NONCE_BYTES = 12


def _decode_key(value: str) -> bytes:
    try:
        padding = "=" * (-len(value.strip()) % 4)
        key = base64.b64decode(
            (value.strip() + padding).encode("ascii"), altchars=b"-_", validate=True
        )
    except (UnicodeError, ValueError, binascii.Error) as error:
        raise StorageError("Embedding encryption key is not valid base64url.") from error
    if len(key) != KEY_BYTES:
        raise StorageError("Embedding encryption key must contain exactly 32 bytes.")
    return key


def load_encryption_key(
    value: str | bytes | None = None,
    *,
    key_file: str | Path | None = None,
) -> bytes:
    """Load a 256-bit key without exposing its contents in errors or logs."""

    if isinstance(value, bytes):
        if len(value) != KEY_BYTES:
            raise StorageError("Embedding encryption key must contain exactly 32 bytes.")
        return value
    if isinstance(value, str) and value.strip():
        return _decode_key(value)

    configured_value = os.getenv("FACEROLL_EMBEDDING_KEY", "").strip()
    configured_file = key_file or os.getenv("FACEROLL_EMBEDDING_KEY_FILE", "").strip()
    if configured_value:
        return _decode_key(configured_value)
    if not configured_file:
        raise StorageError(
            "Embedding encryption is not configured. Set FACEROLL_EMBEDDING_KEY_FILE."
        )

    path = Path(configured_file).expanduser()
    if path.is_symlink() or not path.is_file():
        raise StorageError("Embedding encryption key path must be a regular file.")
    try:
        return _decode_key(path.read_text(encoding="ascii"))
    except OSError as error:
        raise StorageError("Could not read the embedding encryption key file.") from error


def is_encrypted_envelope(data: Any) -> bool:
    return isinstance(data, Mapping) and data.get("format") == ENCRYPTED_FORMAT


def encrypt_record(plaintext: str, *, uid: str, key: bytes) -> str:
    nonce = os.urandom(NONCE_BYTES)
    associated_data = f"{ENCRYPTED_FORMAT}:{ENCRYPTED_VERSION}:{uid}".encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), associated_data)
    return json.dumps(
        {
            "format": ENCRYPTED_FORMAT,
            "version": ENCRYPTED_VERSION,
            "algorithm": ENCRYPTION_ALGORITHM,
            "nonce": base64.urlsafe_b64encode(nonce).decode("ascii"),
            "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("ascii"),
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def decrypt_record(envelope: Mapping[str, Any], *, uid: str, key: bytes) -> str:
    if envelope.get("version") != ENCRYPTED_VERSION:
        raise StorageError("Enrollment encryption version is unsupported.")
    if envelope.get("algorithm") != ENCRYPTION_ALGORITHM:
        raise StorageError("Enrollment encryption algorithm is unsupported.")
    try:
        if not isinstance(envelope["nonce"], str) or not isinstance(
            envelope["ciphertext"], str
        ):
            raise ValueError
        nonce = base64.b64decode(
            envelope["nonce"].encode("ascii"), altchars=b"-_", validate=True
        )
        ciphertext = base64.b64decode(
            envelope["ciphertext"].encode("ascii"), altchars=b"-_", validate=True
        )
    except (KeyError, UnicodeError, ValueError, binascii.Error) as error:
        raise StorageError("Encrypted enrollment envelope is malformed.") from error
    if len(nonce) != NONCE_BYTES:
        raise StorageError("Encrypted enrollment nonce is malformed.")

    associated_data = f"{ENCRYPTED_FORMAT}:{ENCRYPTED_VERSION}:{uid}".encode("utf-8")
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, associated_data)
        return plaintext.decode("utf-8")
    except (InvalidTag, UnicodeError) as error:
        raise StorageError(
            "Encrypted enrollment authentication failed; the key or file is invalid."
        ) from error
