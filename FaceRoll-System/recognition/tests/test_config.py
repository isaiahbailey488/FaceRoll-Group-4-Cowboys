import unittest
from dataclasses import FrozenInstanceError

from faceroll_recognition import SETTINGS, RecognitionSettings
from faceroll_recognition.config import (
    ALIGN_FACES,
    CORE_VERSION,
    DETECTOR_BACKEND,
    DISTANCE_METRIC,
    DISTANCE_THRESHOLD,
    EMBEDDING_DIMENSION,
    EMBEDDING_SCHEMA_VERSION,
    EMBEDDING_VERSION,
    ENFORCE_DETECTION,
    MODEL_NAME,
)
from faceroll_recognition.errors import (
    IncompatibleEmbeddingError,
    InvalidEmbeddingError,
    RecognitionCoreError,
)


class RecognitionSettingsTests(unittest.TestCase):
    def test_authoritative_facenet512_contract(self):
        self.assertEqual(MODEL_NAME, "Facenet512")
        self.assertEqual(DETECTOR_BACKEND, "opencv")
        self.assertEqual(DISTANCE_METRIC, "cosine")
        self.assertEqual(DISTANCE_THRESHOLD, 0.30)
        self.assertTrue(ALIGN_FACES)
        self.assertTrue(ENFORCE_DETECTION)
        self.assertEqual(EMBEDDING_DIMENSION, 512)
        self.assertEqual(EMBEDDING_SCHEMA_VERSION, 1)
        self.assertEqual(EMBEDDING_VERSION, 1)
        self.assertEqual(CORE_VERSION, "0.1.0")

    def test_settings_are_immutable(self):
        with self.assertRaises(FrozenInstanceError):
            SETTINGS.model_name = "Facenet"

    def test_other_models_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "must be Facenet512"):
            RecognitionSettings(model_name="Facenet")

    def test_wrong_embedding_dimension_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "512 values"):
            RecognitionSettings(embedding_dimension=128)

    def test_invalid_threshold_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "between 0 and 2"):
            RecognitionSettings(distance_threshold=0.0)


class RecognitionErrorTests(unittest.TestCase):
    def test_incompatible_embedding_is_a_core_error(self):
        error = IncompatibleEmbeddingError("old model")
        self.assertIsInstance(error, InvalidEmbeddingError)
        self.assertIsInstance(error, RecognitionCoreError)


if __name__ == "__main__":
    unittest.main()
