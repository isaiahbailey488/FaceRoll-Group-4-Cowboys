"""
FaceRoll recognition backend.

A small Flask service that runs DeepFace (Facenet512) for face enrollment
and recognition. Only the 512-dim embedding vector is stored on disk
(face_data/<uid>.json) — raw images are never persisted.

Run:
    python -m venv venv
    venv\\Scripts\\activate   (Windows)
    pip install -r requirements.txt
    python app.py

The server listens on http://0.0.0.0:5001 (Firebase hosting emulator uses 5000).
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import base64
import os
import json
import logging
from datetime import datetime

try:
    import numpy as np
    import cv2
    from deepface import DeepFace
    DEEPFACE_AVAILABLE = True
except ImportError as _e:
    DEEPFACE_AVAILABLE = False
    _import_error = str(_e)

load_dotenv()

MODEL_NAME = os.getenv('FACEROLL_MODEL', 'Facenet512')
DETECTOR_BACKEND = os.getenv('FACEROLL_DETECTOR', 'opencv')
DISTANCE_METRIC = os.getenv('FACEROLL_METRIC', 'cosine')
# DeepFace's recommended threshold for Facenet512+cosine is 0.30.
THRESHOLD = float(os.getenv('FACEROLL_THRESHOLD', '0.30'))

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# { uid: { "embedding": [...], "enrolled_at": "..." } }
enrolled_faces: dict = {}

DATA_DIR = os.path.join(os.path.dirname(__file__), 'face_data')
os.makedirs(DATA_DIR, exist_ok=True)


def _decode_base64_to_image(image_b64: str):
    """Decode a base64 image string into an OpenCV BGR array."""
    if ',' in image_b64 and image_b64.strip().startswith('data:'):
        image_b64 = image_b64.split(',', 1)[1]

    img_bytes = base64.b64decode(image_b64)
    img_array = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('Could not decode image bytes.')
    return img


def _generate_embedding(img) -> list:
    """Extract the embedding vector for the first face in the image."""
    results = DeepFace.represent(
        img,
        model_name=MODEL_NAME,
        detector_backend=DETECTOR_BACKEND,
        enforce_detection=True,
        align=True,
    )
    if not results:
        raise ValueError('No face detected.')
    return list(results[0]['embedding'])


def _cosine_distance(a, b) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denom = (np.linalg.norm(a) * np.linalg.norm(b)) + 1e-10
    return float(1.0 - (np.dot(a, b) / denom))


def _ensure_deepface():
    if not DEEPFACE_AVAILABLE:
        return jsonify({
            'success': False,
            'message': (
                'DeepFace is not installed. Run `pip install -r requirements.txt`. '
                f'Import error: {_import_error}'
            ),
        }), 503
    return None


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'service': 'FaceRoll Recognition Backend',
        'version': '1.1.0',
        'deepface_available': DEEPFACE_AVAILABLE,
        'model': MODEL_NAME,
        'detector': DETECTOR_BACKEND,
        'metric': DISTANCE_METRIC,
        'threshold': THRESHOLD,
        'enrolled_count': len(enrolled_faces),
        'timestamp': datetime.utcnow().isoformat() + 'Z',
    })


@app.route('/enroll', methods=['POST'])
def enroll():
    """Enroll a student's face. Stores only the embedding vector."""
    guard = _ensure_deepface()
    if guard is not None:
        return guard

    data = request.get_json(silent=True)
    if not data:
        return jsonify({'success': False, 'message': 'Invalid request body.'}), 400

    uid = str(data.get('uid', '')).strip()
    image_b64 = str(data.get('image', '')).strip()

    if not uid:
        return jsonify({'success': False, 'message': 'Missing uid.'}), 400
    if not image_b64:
        return jsonify({'success': False, 'message': 'Missing image data.'}), 400

    try:
        img = _decode_base64_to_image(image_b64)
        logger.info(f"[enroll] uid={uid} image_shape={img.shape}")

        embedding = _generate_embedding(img)

        record = {
            'uid': uid,
            'embedding': embedding,
            'model': MODEL_NAME,
            'enrolled_at': datetime.utcnow().isoformat() + 'Z',
        }
        enrolled_faces[uid] = record

        face_file = os.path.join(DATA_DIR, f'{uid}.json')
        with open(face_file, 'w') as f:
            json.dump(record, f)

        logger.info(f"[enroll] uid={uid} enrolled (dim={len(embedding)})")

        return jsonify({
            'success': True,
            'message': f'Face enrolled successfully for user {uid}.',
            'uid': uid,
        })

    except ValueError as ve:
        logger.warning(f"[enroll] uid={uid} no_face: {ve}")
        return jsonify({
            'success': False,
            'message': 'No face detected. Please center your face in the frame and try again.',
        }), 400
    except Exception as e:
        logger.error(f"[enroll] uid={uid} error: {e}", exc_info=True)
        return jsonify({'success': False, 'message': f'Enrollment failed: {str(e)}'}), 500


@app.route('/recognize', methods=['POST'])
def recognize():
    """Recognize a face for attendance check-in."""
    guard = _ensure_deepface()
    if guard is not None:
        return guard

    data = request.get_json(silent=True)
    if not data:
        return jsonify({'success': False, 'recognized': False, 'message': 'Invalid request body.'}), 400

    image_b64 = str(data.get('image', '')).strip()
    session_id = str(data.get('sessionId', '')).strip()
    expected_uid = str(data.get('uid', '')).strip()

    if not image_b64:
        return jsonify({'success': False, 'recognized': False, 'message': 'Missing image data.'}), 400

    if not enrolled_faces:
        return jsonify({
            'success': True,
            'recognized': False,
            'message': 'No enrolled faces in the system.',
            'confidence': 0.0,
        })

    try:
        img = _decode_base64_to_image(image_b64)
        query_embedding = _generate_embedding(img)

        # If a uid was passed in, do 1:1 verification; otherwise 1:N.
        if expected_uid and expected_uid in enrolled_faces:
            candidates = {expected_uid: enrolled_faces[expected_uid]}
        else:
            candidates = enrolled_faces

        best_uid = None
        best_distance = float('inf')

        for uid, record in candidates.items():
            d = _cosine_distance(query_embedding, record['embedding'])
            if d < best_distance:
                best_distance = d
                best_uid = uid

        recognized = best_distance <= THRESHOLD
        confidence = max(0.0, 1.0 - (best_distance / THRESHOLD)) if THRESHOLD > 0 else 0.0

        logger.info(
            f"[recognize] session={session_id or '-'} "
            f"best_uid={best_uid} distance={best_distance:.4f} "
            f"threshold={THRESHOLD} recognized={recognized}"
        )

        return jsonify({
            'success': True,
            'recognized': recognized,
            'uid': best_uid if recognized else '',
            'confidence': round(confidence, 4),
            'distance': round(best_distance, 4),
            'threshold': THRESHOLD,
            'sessionId': session_id,
        })

    except ValueError as ve:
        logger.warning(f"[recognize] no_face: {ve}")
        return jsonify({
            'success': True,
            'recognized': False,
            'message': 'No face detected. Please center your face in the frame and try again.',
            'confidence': 0.0,
        })
    except Exception as e:
        logger.error(f"[recognize] error: {e}", exc_info=True)
        return jsonify({
            'success': False,
            'recognized': False,
            'message': f'Recognition failed: {str(e)}'
        }), 500


@app.route('/enrolled', methods=['GET'])
def list_enrolled():
    """List enrolled uids (never returns embeddings)."""
    return jsonify({
        'enrolled_uids': list(enrolled_faces.keys()),
        'count': len(enrolled_faces),
    })


@app.route('/enroll/<uid>', methods=['DELETE'])
def delete_enrollment(uid: str):
    """Delete a user's enrolled face data."""
    existed = uid in enrolled_faces
    if existed:
        del enrolled_faces[uid]
    face_file = os.path.join(DATA_DIR, f'{uid}.json')
    if os.path.exists(face_file):
        os.remove(face_file)
        existed = True

    if existed:
        logger.info(f"[delete] uid={uid}")
        return jsonify({'success': True, 'message': f'Enrollment deleted for {uid}.'})
    return jsonify({'success': False, 'message': f'No enrollment found for {uid}.'}), 404


def load_persisted_faces():
    """Load embeddings saved to disk on startup."""
    loaded = 0
    for filename in os.listdir(DATA_DIR):
        if filename.endswith('.json'):
            uid = filename[:-5]
            try:
                with open(os.path.join(DATA_DIR, filename), 'r') as f:
                    enrolled_faces[uid] = json.load(f)
                loaded += 1
            except Exception as e:
                logger.warning(f"Could not load face data for {uid}: {e}")
    if loaded > 0:
        logger.info(f"Loaded {loaded} persisted face enrollment(s).")


if __name__ == '__main__':
    load_persisted_faces()
    PORT = int(os.getenv('FACEROLL_PORT', '5001'))
    logger.info(
        f"FaceRoll Recognition Backend starting on http://0.0.0.0:{PORT} "
        f"(model={MODEL_NAME}, detector={DETECTOR_BACKEND}, threshold={THRESHOLD})"
    )
    if not DEEPFACE_AVAILABLE:
        logger.warning(
            "DeepFace dependencies are NOT installed. /enroll and /recognize "
            "will return 503."
        )
    app.run(host='0.0.0.0', port=PORT, debug=True)
