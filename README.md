# FaceRoll Mobile

FaceRoll Mobile is the student component of FaceRoll.  
It is built with Expo (React Native) and TypeScript, and integrates with Firebase and a Python backend for facial enrollment and recognition.

## Overview

This application enables students to:

- authenticate with email and password
- manage profile and facial enrollment settings
- perform attendance check-in during active sessions
- view recent attendance activity

The app writes attendance data to Firestore, where it is written to the instructor dashboard in near real time.

## Key Features

- Authentication with Firebase Auth
- Student profile and settings management
- Face enrollment and attendance check-in camera flows
- Firestore-backed attendance activity feed
- Integration path for DeepFace-based recognition backend
- Shared data model with the instructor web dashboard

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile Framework | Expo SDK 54 + React Native |
| Language | TypeScript |
| Navigation | Expo Router |
| Authentication | Firebase Auth |
| Database | Cloud Firestore |
| Camera | expo-camera |
| Recognition Service | Python Flask (DeepFace integration path) |

## Prerequisites

- Node.js 18+ and npm
- Python 3.10+ (recommended for backend compatibility)
- Expo Go on iOS/Android device (or emulator/simulator)
- Firebase project access (Auth + Firestore enabled)

## Setup and Configuration

### 1) Install Dependencies

From the repository root:

```bash
npm install
```

### 2) Configure Firebase

Update `services/firebase.ts` with your Firebase Web SDK config values.

Reference project:
- Firebase Console: `rollcall-2669b`
- Console link: https://console.firebase.google.com/project/rollcall-2669b

Expected object shape:

```ts
const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'rollcall-2669b.firebaseapp.com',
  projectId: 'rollcall-2669b',
  storageBucket: 'rollcall-2669b.appspot.com',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId: 'YOUR_APP_ID',
};
```

### 3) Configure Firestore Rules

Deploy the rules from `firestore.rules` to avoid permission errors.

Using Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase use rollcall-2669b
firebase deploy --only firestore:rules
```

### 4) Run the Mobile App

```bash
npx expo start
```

Then open in Expo Go by scanning the QR code.

### 5) Run the Face Recognition Backend

From the repository root:

```bash
cd backend
pip install -r requirements.txt
python app.py
```

Default backend URL:

```text
http://0.0.0.0:5000
```

For physical-device testing, set `BACKEND_URL` in `services/attendance.ts` to your machine's LAN IP, for example:

```ts
export const BACKEND_URL = 'http://192.168.1.100:5000';
```

Your phone and development machine must be on the same network.

## Data Model

The mobile app reads and writes to the following Firestore collections:

| Collection | Purpose |
|---|---|
| `users/{uid}` | Student profile and role data |
| `courses/{courseId}` | Course metadata |
| `sessions/{sessionId}` | Attendance session definitions |
| `attendance/{recordId}` | Student attendance records |

## Implemented Routes

| Route | Screen Purpose |
|---|---|
| `/(auth)/login` | Student sign in |
| `/(auth)/register` | Student account creation |
| `/(tabs)/home` | Student home and recent attendance |
| `/(tabs)/profile` | Profile and enrollment settings |
| `/face-enrollment` | Facial enrollment camera flow |
| `/attendance-checkin` | Attendance check-in camera flow |

## Troubleshooting

1. **Firestore permission errors**
   - Confirm `firestore.rules` has been deployed to the target Firebase project.

2. **Backend not reachable from mobile device**
   - Use LAN IP (not `localhost`) in `BACKEND_URL`.
   - Ensure firewall allows inbound traffic to backend port.

3. **Expo app starts but camera flow fails**
   - Confirm camera permissions are granted on the device.
   - Verify backend server is running before enrollment/check-in.

4. **Authentication issues**
   - Confirm Email/Password sign-in provider is enabled in Firebase Auth.

## Course and Team Information

- **Project:** FaceRoll - Facial Recognition Attendance System
- **Course:** CSCE 4905.501 - Information Technology Capstone I
- **Team:** Cowboys (Group 4)

### Team Members

- Gabriel Oniyitan (Team Lead)
- Austin Woodruff
- Moses Ojo
- Cade Powell
- Isaiah Bailey
