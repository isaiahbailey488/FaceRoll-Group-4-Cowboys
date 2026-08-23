# FaceRoll System Architecture

## Overview

FaceRoll consists of a student mobile application, an instructor web dashboard, shared Firebase services, and two Python-based facial-recognition workflows.

```text
Student Mobile App ──┬── Firebase Authentication
                    ├── Cloud Firestore
                    └── Mobile Recognition API

Instructor Dashboard ──┬── Firebase Authentication
                       ├── Cloud Firestore
                       └── Local Recognition Bridge ── Webcam Recognition
```

## Student Workflow

1. The student registers or signs in through Firebase Authentication.
2. Profile information is stored in the `users` Firestore collection.
3. The mobile camera sends an enrollment image to the Flask recognition API.
4. The API creates and stores a face embedding without intentionally retaining the submitted image.
5. During check-in, the app obtains an active session from Firestore and submits a new image for recognition.
6. After successful recognition, the app writes the student's attendance record to Firestore.

## Instructor Workflow

1. The instructor signs in to the Firebase-hosted dashboard.
2. The instructor manages courses, students, settings, and attendance records through Firestore.
3. Starting a live session creates a session record and contacts the local recognition bridge.
4. The bridge starts the webcam capture and Docker-based recognition processes.
5. The dashboard polls the bridge for recognition events and writes matching attendance records to Firestore.
6. The instructor reviews, filters, corrects, or exports the resulting records.

## Shared Data

| Firestore collection | Responsibility |
|---|---|
| `users` | Student and instructor profiles, roles, and recognition preferences |
| `courses` | Course names, identifiers, and instructor ownership |
| `sessions` | Active and completed attendance sessions |
| `attendance` | Student status for a particular course and session |
| `instructor_settings` | Instructor-specific attendance configuration |

## Recognition Services

The mobile Flask API and instructor recognition bridge are separate services:

- The mobile API handles images submitted by the Expo application.
- The local instructor bridge controls webcam capture and exposes session status and recognition events to the dashboard.
- Windows and macOS have separate bridge directories because camera and Docker behavior differs by platform.

