import copy
import json
import unittest

import numpy as np

from faceroll_recognition import EnrollmentRecord
from faceroll_recognition.errors import (
    IncompatibleEmbeddingError,
    InvalidEmbeddingError,
)


TIMESTAMP = "2026-08-31T16:00:00Z"


def unit_vector(index):
    vector = np.zeros(512, dtype=np.float32)
    vector[index] = 1.0
    return vector.tolist()


def valid_record_data():
    return {
        "schema_version": 1,
        "embedding_version": 1,
        "student_uid": "firebase-uid-123",
        "student_id": "school-id-456",
        "display_name": "Example Student",
        "model": "Facenet512",
        "detector": "opencv",
        "distance_metric": "cosine",
        "embedding_dimension": 512,
        "created_at": TIMESTAMP,
        "updated_at": TIMESTAMP,
        "embeddings": [
            {
                "embedding_id": f"embedding_{index + 1:03d}",
                "created_at": TIMESTAMP,
                "vector": unit_vector(index),
            }
            for index in range(3)
        ],
    }


class ValidEnrollmentSchemaTests(unittest.TestCase):
    def test_valid_facenet512_record_loads(self):
        record = EnrollmentRecord.from_dict(valid_record_data())
        self.assertEqual(record.recognition_uid, "firebase-uid-123")
        self.assertEqual(record.student_id, "school-id-456")
        self.assertEqual(record.display_name, "Example Student")
        self.assertEqual(len(record.embeddings), 3)
        self.assertEqual(len(record.enrolled_vectors[0]), 512)

    def test_optional_display_metadata_can_be_omitted(self):
        data = valid_record_data()
        data.pop("student_id")
        data.pop("display_name")
        record = EnrollmentRecord.from_dict(data)
        self.assertIsNone(record.student_id)
        self.assertIsNone(record.display_name)
        self.assertEqual(record.recognition_uid, "firebase-uid-123")

    def test_json_round_trip_preserves_record(self):
        original = EnrollmentRecord.from_dict(valid_record_data())
        reloaded = EnrollmentRecord.from_json(original.to_json())
        self.assertEqual(reloaded, original)

    def test_create_assigns_three_stable_embedding_ids(self):
        record = EnrollmentRecord.create(
            student_uid="firebase-uid-123",
            student_id="school-id-456",
            display_name="Example Student",
            vectors=[unit_vector(0), unit_vector(1), unit_vector(2)],
            created_at=TIMESTAMP,
        )
        self.assertEqual(
            [item.embedding_id for item in record.embeddings],
            ["embedding_001", "embedding_002", "embedding_003"],
        )

    def test_candidates_always_use_firebase_uid(self):
        record = EnrollmentRecord.from_dict(valid_record_data())
        candidates = record.to_candidates()
        self.assertEqual({candidate.uid for candidate in candidates}, {"firebase-uid-123"})
        self.assertNotIn("Example Student", {candidate.uid for candidate in candidates})
        self.assertNotIn("school-id-456", {candidate.uid for candidate in candidates})


class InvalidEnrollmentSchemaTests(unittest.TestCase):
    def assert_invalid(self, mutate, error_type=InvalidEmbeddingError, message=None):
        data = valid_record_data()
        mutate(data)
        context = self.assertRaisesRegex(error_type, message) if message else self.assertRaises(error_type)
        with context:
            EnrollmentRecord.from_dict(data)

    def test_missing_firebase_uid_is_rejected(self):
        self.assert_invalid(
            lambda data: data.pop("student_uid"),
            message="missing 'student_uid'",
        )

    def test_blank_firebase_uid_is_rejected(self):
        self.assert_invalid(
            lambda data: data.update(student_uid="  "),
            message="student_uid.*non-empty",
        )

    def test_old_facenet_model_is_rejected_clearly(self):
        self.assert_invalid(
            lambda data: data.update(model="Facenet"),
            IncompatibleEmbeddingError,
            "incompatible model 'Facenet'.*'Facenet512'",
        )

    def test_wrong_declared_dimension_is_rejected(self):
        self.assert_invalid(
            lambda data: data.update(embedding_dimension=128),
            IncompatibleEmbeddingError,
            "dimension 128.*512",
        )

    def test_wrong_vector_dimension_is_rejected(self):
        self.assert_invalid(
            lambda data: data["embeddings"][0].update(vector=[1.0] * 128),
            message="512 values",
        )

    def test_missing_vector_is_rejected(self):
        self.assert_invalid(
            lambda data: data["embeddings"][0].pop("vector"),
            message="missing 'vector'",
        )

    def test_text_values_are_rejected(self):
        self.assert_invalid(
            lambda data: data["embeddings"][0].update(vector=["1"] * 512),
            message="only numbers",
        )

    def test_nan_is_rejected(self):
        def add_nan(data):
            data["embeddings"][0]["vector"][10] = float("nan")

        self.assert_invalid(add_nan, message="NaN or infinite")

    def test_zero_vector_is_rejected(self):
        self.assert_invalid(
            lambda data: data["embeddings"][0].update(vector=[0.0] * 512),
            message="zero vector",
        )

    def test_duplicate_embedding_ids_are_rejected(self):
        def duplicate_id(data):
            data["embeddings"][1]["embedding_id"] = "embedding_001"

        self.assert_invalid(duplicate_id, message="IDs must be unique")

    def test_two_sample_enrollment_is_rejected(self):
        self.assert_invalid(
            lambda data: data["embeddings"].pop(),
            message="exactly 3 embeddings; received 2",
        )

    def test_four_sample_enrollment_is_rejected(self):
        def add_sample(data):
            extra = copy.deepcopy(data["embeddings"][0])
            extra["embedding_id"] = "embedding_004"
            data["embeddings"].append(extra)

        self.assert_invalid(add_sample, message="exactly 3 embeddings; received 4")

    def test_unsupported_schema_version_is_rejected(self):
        self.assert_invalid(
            lambda data: data.update(schema_version=2),
            IncompatibleEmbeddingError,
            "schema version 2; expected 1",
        )

    def test_unsupported_embedding_version_is_rejected(self):
        self.assert_invalid(
            lambda data: data.update(embedding_version=2),
            IncompatibleEmbeddingError,
            "embedding version 2; expected 1",
        )

    def test_invalid_timestamp_is_rejected(self):
        self.assert_invalid(
            lambda data: data.update(created_at="yesterday"),
            message="valid UTC ISO-8601",
        )

    def test_timestamp_without_timezone_is_rejected(self):
        self.assert_invalid(
            lambda data: data.update(created_at="2026-08-31T16:00:00"),
            message="include the UTC timezone",
        )

    def test_updated_timestamp_cannot_precede_creation(self):
        self.assert_invalid(
            lambda data: data.update(updated_at="2026-08-31T15:59:59Z"),
            message="cannot be earlier",
        )

    def test_json_root_array_is_rejected(self):
        with self.assertRaisesRegex(InvalidEmbeddingError, "root must be an object"):
            EnrollmentRecord.from_json("[]")

    def test_malformed_json_is_rejected(self):
        with self.assertRaisesRegex(InvalidEmbeddingError, "JSON is malformed"):
            EnrollmentRecord.from_json("{not-json")

    def test_json_serialization_never_allows_nan(self):
        record = EnrollmentRecord.from_dict(valid_record_data())
        serialized = record.to_json()
        parsed = json.loads(serialized)
        self.assertEqual(parsed["student_uid"], "firebase-uid-123")


if __name__ == "__main__":
    unittest.main()
