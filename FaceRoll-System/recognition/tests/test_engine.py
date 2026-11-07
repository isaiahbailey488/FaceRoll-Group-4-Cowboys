import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from faceroll_recognition import (
    EmbeddingCandidate,
    DependencyUnavailableError,
    InvalidEmbeddingError,
    InvalidImageError,
    MultipleFacesDetectedError,
    NoFaceDetectedError,
    cosine_distance,
    decode_base64_image,
    find_best_match,
    generate_detected_embeddings,
    generate_embeddings,
    generate_single_embedding,
    load_image_file,
    validate_embedding,
    validate_image,
    verify_embedding,
)


def unit_vector(index=0):
    vector = np.zeros(512, dtype=np.float32)
    vector[index] = 1.0
    return vector


class FakeDeepFace:
    results = []
    error = None
    calls = []

    @classmethod
    def represent(cls, **kwargs):
        cls.calls.append(kwargs)
        if cls.error:
            raise cls.error
        return cls.results


class FakeOpenCV:
    IMREAD_COLOR = 1
    decoded_image = None
    file_image = None

    @classmethod
    def imdecode(cls, _data, _mode):
        return cls.decoded_image

    @classmethod
    def imread(cls, _path, _mode):
        return cls.file_image


class ImageInputTests(unittest.TestCase):
    def setUp(self):
        FakeOpenCV.decoded_image = np.ones((2, 2, 3), dtype=np.uint8)
        FakeOpenCV.file_image = np.ones((2, 2, 3), dtype=np.uint8)

    def test_validate_image_accepts_color_array(self):
        image = np.ones((2, 3, 3), dtype=np.uint8)
        self.assertIs(validate_image(image), image)

    def test_validate_image_rejects_non_array(self):
        with self.assertRaises(InvalidImageError):
            validate_image("not-an-image")

    def test_decode_base64_image_accepts_data_url(self):
        payload = base64.b64encode(b"image-bytes").decode("ascii")
        with patch("faceroll_recognition.engine.cv2", FakeOpenCV):
            image = decode_base64_image(f"data:image/jpeg;base64,{payload}")
        self.assertEqual(image.shape, (2, 2, 3))

    def test_decode_base64_image_rejects_invalid_payload(self):
        with self.assertRaises(InvalidImageError):
            decode_base64_image("%%%")

    def test_decode_base64_image_rejects_undecodable_bytes(self):
        payload = base64.b64encode(b"not-an-image").decode("ascii")
        FakeOpenCV.decoded_image = None
        with patch("faceroll_recognition.engine.cv2", FakeOpenCV):
            with self.assertRaises(InvalidImageError):
                decode_base64_image(payload)

    def test_load_image_file_uses_same_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "face.jpg"
            path.write_bytes(b"test")
            with patch("faceroll_recognition.engine.cv2", FakeOpenCV):
                image = load_image_file(path)
        self.assertEqual(image.shape, (2, 2, 3))

    def test_opencv_dependency_guard(self):
        payload = base64.b64encode(b"image-bytes").decode("ascii")
        with patch("faceroll_recognition.engine.cv2", None):
            with self.assertRaises(DependencyUnavailableError):
                decode_base64_image(payload)


class EmbeddingGenerationTests(unittest.TestCase):
    def setUp(self):
        FakeDeepFace.results = []
        FakeDeepFace.error = None
        FakeDeepFace.calls = []
        self.image = np.ones((2, 2, 3), dtype=np.uint8)

    def test_generate_embeddings_uses_authoritative_configuration(self):
        FakeDeepFace.results = [{"embedding": unit_vector().tolist()}]
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            embeddings = generate_embeddings(self.image)

        self.assertEqual(len(embeddings), 1)
        self.assertEqual(embeddings[0].shape, (512,))
        call = FakeDeepFace.calls[0]
        self.assertEqual(call["model_name"], "Facenet512")
        self.assertEqual(call["detector_backend"], "opencv")
        self.assertTrue(call["enforce_detection"])
        self.assertTrue(call["align"])

    def test_generate_embeddings_supports_multiple_faces(self):
        FakeDeepFace.results = [
            {"embedding": unit_vector(0).tolist()},
            {"embedding": unit_vector(1).tolist()},
        ]
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            embeddings = generate_embeddings(self.image)
        self.assertEqual(len(embeddings), 2)

    def test_detected_embeddings_include_valid_face_bounds(self):
        FakeDeepFace.results = [
            {
                "embedding": unit_vector(0).tolist(),
                "facial_area": {"x": 10, "y": 20, "w": 30, "h": 40},
            }
        ]
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            detected = generate_detected_embeddings(self.image)

        self.assertEqual(len(detected), 1)
        self.assertEqual(detected[0].region.x, 10)
        self.assertEqual(detected[0].region.y, 20)
        self.assertEqual(detected[0].region.width, 30)
        self.assertEqual(detected[0].region.height, 40)

    def test_malformed_face_bounds_do_not_break_embedding_generation(self):
        FakeDeepFace.results = [
            {
                "embedding": unit_vector(0).tolist(),
                "facial_area": {"x": "bad", "y": 20, "w": 30, "h": 40},
            }
        ]
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            detected = generate_detected_embeddings(self.image)

        self.assertEqual(len(detected), 1)
        self.assertIsNone(detected[0].region)

    def test_single_embedding_rejects_multiple_faces(self):
        FakeDeepFace.results = [
            {"embedding": unit_vector(0).tolist()},
            {"embedding": unit_vector(1).tolist()},
        ]
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            with self.assertRaises(MultipleFacesDetectedError):
                generate_single_embedding(self.image)

    def test_empty_deepface_result_is_no_face(self):
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            with self.assertRaises(NoFaceDetectedError):
                generate_single_embedding(self.image)

    def test_deepface_detection_error_is_no_face(self):
        FakeDeepFace.error = ValueError("Face could not be detected")
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            with self.assertRaises(NoFaceDetectedError):
                generate_single_embedding(self.image)

    def test_deepface_dependency_guard(self):
        with patch("faceroll_recognition.engine.DeepFace", None):
            with self.assertRaises(DependencyUnavailableError):
                generate_embeddings(self.image)


class SingleFaceDuplicateTests(unittest.TestCase):
    def setUp(self):
        self.image = np.ones((400, 400, 3), dtype=np.uint8)
        FakeDeepFace.error = None
        FakeDeepFace.calls = []

    def detection(self, x=100, y=100, w=100, h=120, vector=None):
        return {"embedding": (unit_vector() if vector is None else vector).tolist(),
                "facial_area": {"x": x, "y": y, "w": w, "h": h}}

    def generate(self, results):
        FakeDeepFace.results = results
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            return generate_single_embedding(self.image)

    def test_duplicate_boxes_on_same_face_return_an_original_vector(self):
        near = unit_vector() + unit_vector(1) * 0.1
        result = self.generate([self.detection(), self.detection(x=101, y=102, vector=near)])
        np.testing.assert_array_equal(result, unit_vector())
        self.assertEqual(FakeDeepFace.calls[0]['detector_backend'], 'opencv')
        self.assertTrue(FakeDeepFace.calls[0]['enforce_detection'])

    def test_same_embedding_in_separate_regions_is_still_multiple_faces(self):
        with self.assertRaises(MultipleFacesDetectedError):
            self.generate([self.detection(), self.detection(x=250)])

    def test_overlapping_boxes_with_different_embeddings_are_not_merged(self):
        for x in (100, 101):
            with self.subTest(x=x), self.assertRaises(MultipleFacesDetectedError):
                self.generate([self.detection(), self.detection(x=x, vector=unit_vector(1))])

    def test_merely_similar_identity_embeddings_do_not_establish_a_duplicate(self):
        # This pair passes the normal 0.30 identity threshold, but is too
        # different to justify collapsing two detections into one face.
        similar = unit_vector() + unit_vector(1) * 0.5
        with self.assertRaises(MultipleFacesDetectedError):
            self.generate([self.detection(), self.detection(vector=similar)])

    def test_partial_overlap_or_nested_small_detection_is_not_a_duplicate(self):
        for other in (self.detection(x=115), self.detection(x=125, y=125, w=40, h=40)):
            with self.subTest(other=other['facial_area']), self.assertRaises(MultipleFacesDetectedError):
                self.generate([self.detection(), other])

    def test_missing_invalid_or_clipped_bounds_cannot_hide_another_face(self):
        missing = self.detection()
        del missing['facial_area']
        malformed = self.detection()
        malformed['facial_area']['x'] = 'invalid'
        for other in (missing, malformed, self.detection(x=0), self.detection(w=0),
                      self.detection(w=-1), self.detection(x=350)):
            with self.subTest(other=other.get('facial_area')), self.assertRaises(MultipleFacesDetectedError):
                self.generate([self.detection(), other])

    def test_overlapping_chain_cannot_merge_two_different_regions(self):
        # The middle box overlaps both neighbours strongly; the outer boxes
        # do not agree. Test the middle first to catch representative-only NMS.
        with self.assertRaises(MultipleFacesDetectedError):
            self.generate([self.detection(x=104), self.detection(x=100), self.detection(x=108)])

    def test_duplicate_pair_does_not_hide_a_third_separate_face(self):
        with self.assertRaises(MultipleFacesDetectedError):
            self.generate([self.detection(), self.detection(x=101), self.detection(x=250)])

    def test_general_embedding_generation_still_preserves_all_classroom_faces(self):
        FakeDeepFace.results = [self.detection(), self.detection(x=101)]
        with patch("faceroll_recognition.engine.DeepFace", FakeDeepFace):
            self.assertEqual(len(generate_detected_embeddings(self.image)), 2)
            self.assertEqual(len(generate_embeddings(self.image)), 2)


class EmbeddingValidationTests(unittest.TestCase):
    def test_valid_embedding_becomes_float32(self):
        vector = validate_embedding(unit_vector().astype(np.float64))
        self.assertEqual(vector.dtype, np.float32)

    def test_wrong_dimension_is_rejected(self):
        with self.assertRaises(InvalidEmbeddingError):
            validate_embedding([1.0] * 128)

    def test_non_finite_values_are_rejected(self):
        vector = unit_vector()
        vector[1] = np.nan
        with self.assertRaises(InvalidEmbeddingError):
            validate_embedding(vector)

    def test_zero_vector_is_rejected(self):
        with self.assertRaises(InvalidEmbeddingError):
            validate_embedding(np.zeros(512))


class MatchingTests(unittest.TestCase):
    def test_identical_vectors_have_zero_distance(self):
        self.assertAlmostEqual(cosine_distance(unit_vector(), unit_vector()), 0.0)

    def test_orthogonal_vectors_have_distance_one(self):
        self.assertAlmostEqual(cosine_distance(unit_vector(0), unit_vector(1)), 1.0)

    def test_verification_uses_best_enrolled_sample(self):
        result = verify_embedding(
            unit_vector(0),
            [unit_vector(1), unit_vector(0)],
        )
        self.assertTrue(result.recognized)
        self.assertAlmostEqual(result.distance, 0.0)

    def test_verification_rejects_nonmatch(self):
        result = verify_embedding(unit_vector(0), [unit_vector(1)])
        self.assertFalse(result.recognized)
        self.assertEqual(result.confidence, 0.0)

    def test_verification_with_no_enrollment_is_not_recognized(self):
        result = verify_embedding(unit_vector(0), [])
        self.assertFalse(result.recognized)
        self.assertIsNone(result.distance)

    def test_identification_returns_best_candidate(self):
        result = find_best_match(
            unit_vector(0),
            [
                EmbeddingCandidate("student-b", unit_vector(1), "embedding_002"),
                EmbeddingCandidate("student-a", unit_vector(0), "embedding_001"),
            ],
        )
        self.assertTrue(result.recognized)
        self.assertEqual(result.uid, "student-a")
        self.assertEqual(result.embedding_id, "embedding_001")

    def test_identification_hides_candidate_outside_threshold(self):
        result = find_best_match(
            unit_vector(0),
            [EmbeddingCandidate("student-b", unit_vector(1))],
        )
        self.assertFalse(result.recognized)
        self.assertIsNone(result.uid)
        self.assertAlmostEqual(result.distance, 1.0)

    def test_identification_with_no_candidates_is_not_recognized(self):
        result = find_best_match(unit_vector(0), [])
        self.assertFalse(result.recognized)
        self.assertIsNone(result.distance)


if __name__ == "__main__":
    unittest.main()
