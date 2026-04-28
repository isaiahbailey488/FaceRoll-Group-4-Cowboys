from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from deepface import DeepFace
import tempfile
import shutil
import os

app = FastAPI()

MODEL_NAME = "Facenet512"
DETECTOR_BACKEND = "opencv"
DISTANCE_METRIC = "cosine"
DB_PATH = "faces_db"

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/verify")
async def verify(img1: UploadFile = File(...), img2: UploadFile = File(...)):
    tmp1 = None
    tmp2 = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as f1:
            shutil.copyfileobj(img1.file, f1)
            tmp1 = f1.name

        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as f2:
            shutil.copyfileobj(img2.file, f2)
            tmp2 = f2.name

        result = DeepFace.verify(
            img1_path=tmp1,
            img2_path=tmp2,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR_BACKEND,
            distance_metric=DISTANCE_METRIC,
            enforce_detection=True,
        )

        return JSONResponse(
            {
                "verified": result.get("verified"),
                "distance": result.get("distance"),
                "threshold": result.get("threshold"),
                "model": MODEL_NAME,
                "detector": DETECTOR_BACKEND,
            }
        )

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        for path in [tmp1, tmp2]:
            if path and os.path.exists(path):
                os.remove(path)

@app.post("/find")
async def find_face(img: UploadFile = File(...)):
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as f:
            shutil.copyfileobj(img.file, f)
            tmp = f.name

        result = DeepFace.find(
            img_path=tmp,
            db_path=DB_PATH,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR_BACKEND,
            distance_metric=DISTANCE_METRIC,
            enforce_detection=True,
        )

        serializable = []
        for df in result:
            serializable.append(df.to_dict(orient="records"))

        return JSONResponse(
            {
                "matches": serializable,
                "model": MODEL_NAME,
                "detector": DETECTOR_BACKEND,
            }
        )

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)