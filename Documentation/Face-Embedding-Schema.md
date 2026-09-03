# FaceRoll Enrollment Embedding Schema

## Purpose

FaceRoll uses one canonical enrollment format for mobile verification and classroom-camera identification. Enrollment records contain biometric embeddings and must remain on authorized local devices. They must not be uploaded to Firebase or included in logs, analytics, source control, or unencrypted backups.

## Identity

`student_uid` is the Firebase Authentication UID and is the only authoritative recognition identity. `student_id` and `display_name` are optional display metadata. Neither a name nor a school-issued identifier may be used as the recognition key or attendance owner.

## Enrollment Samples

A finalized enrollment contains exactly three independently generated `Facenet512` embeddings:

1. Face forward
2. Head turned slightly left
3. Head turned slightly right

The source photographs are discarded after embedding generation. During verification, the live embedding is compared with all three enrollment samples and the lowest valid cosine distance is used.

## Version 1 JSON Shape

```json
{
  "schema_version": 1,
  "embedding_version": 1,
  "student_uid": "firebase-authentication-uid",
  "student_id": "optional-school-id",
  "display_name": "Optional Display Name",
  "model": "Facenet512",
  "detector": "opencv",
  "distance_metric": "cosine",
  "embedding_dimension": 512,
  "created_at": "2026-08-31T16:00:00Z",
  "updated_at": "2026-08-31T16:00:00Z",
  "embeddings": [
    {
      "embedding_id": "embedding_001",
      "created_at": "2026-08-31T16:00:00Z",
      "vector": ["512 finite numeric values"]
    },
    {
      "embedding_id": "embedding_002",
      "created_at": "2026-08-31T16:00:01Z",
      "vector": ["512 finite numeric values"]
    },
    {
      "embedding_id": "embedding_003",
      "created_at": "2026-08-31T16:00:02Z",
      "vector": ["512 finite numeric values"]
    }
  ]
}
```

The strings shown inside example `vector` arrays are documentation placeholders. Real records contain numbers only.

## Required Validation

- The JSON root is an object.
- `schema_version` and `embedding_version` are supported integers.
- `student_uid` is a non-empty Firebase UID.
- Model, detector, metric, and dimension match the shared recognition configuration.
- A finalized record contains exactly three samples with unique embedding IDs.
- Every vector is one-dimensional, numeric, finite, nonzero, and exactly 512 values long.
- All timestamps are timezone-aware UTC ISO-8601 values.
- `Facenet` and other model records are incompatible with `Facenet512` and must be rejected.
- Missing or malformed fields produce controlled schema errors rather than crashing recognition.

## Privacy Boundary

The schema intentionally excludes raw face images, source image paths, authentication tokens, and cloud-storage locations.

## Local Storage Interface

`EnrollmentReader` provides read-only access for classroom recognition. It can load one student or return a bulk-load report containing valid records and controlled rejection details. A malformed or legacy record does not stop other students from loading.

`MobileEnrollmentStore` provides atomic enrollment replacement and deletion for the future authenticated mobile service. Every mutation requires an `authenticated_uid` that exactly matches the record's `student_uid`. This parameter must come from a verified Firebase ID token once the mobile API is implemented; accepting a UID from an unverified request body is not sufficient authentication.

Storage filenames use the validated Firebase UID:

```text
<firebase-uid>.json
```

On POSIX systems the directory is restricted to mode `0700` and files to `0600`. Writes are flushed to a temporary file and atomically replaced. Symbolic-link records, unsafe UIDs, oversized files, malformed JSON, mismatched filename identities, and incompatible models are rejected.

The storage layer does not store raw images. Encryption at rest and operating-system key protection must still be added before production biometric use.
