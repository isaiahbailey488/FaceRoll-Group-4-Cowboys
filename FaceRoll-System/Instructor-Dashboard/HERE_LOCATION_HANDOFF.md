# HERE Attendance Location Handoff

## Purpose and current status

This document hands off FaceRoll's instructor-dashboard attendance-location configuration. The initial sponsor demonstration has been completed, and the sponsor's next requested change is documented below.

The instructor UI is implemented. It lets an instructor choose a course, view a HERE map, search for an address, place or drag a classroom marker, choose an allowed radius, enable location verification, and save the location to the course document.

## Dashboard architecture

- Dashboard folder: `FaceRoll-System/Instructor-Dashboard`
- Front end: static HTML, CSS, and browser JavaScript hosted through Firebase Hosting
- Authentication and data: Firebase Authentication and Cloud Firestore using the project's existing compatibility SDK pattern
- Courses: Firestore documents in `courses/{courseId}`
- Updates: merge writes through the existing Firebase client helper
- Local development: Firebase Auth and Firestore emulators are selected automatically on `localhost` and `127.0.0.1`
- HERE configuration: the build script reads `HERE_API_KEY` from `.env` or the process environment and generates an ignored browser runtime-config file

There was no existing course-specific settings page. The existing `settings.html` page is for instructor-wide defaults, so a separate `course-settings.html` page was added. Its visual structure follows the existing dashboard, especially the Live Session and Settings pages, and it uses the shared sidebar.

## Completed work

- Added a Course Settings navigation entry.
- Added a course selector and empty/loading/error states.
- Added an interactive HERE Maps JavaScript API map.
- Added HERE Geocoding and Search API address/building search.
- Added click-to-place and draggable classroom marker behavior.
- Added reverse geocoding after map selection.
- Added a visible circle for the allowed attendance radius.
- Added a radius slider from 1 to 15 meters in 1-meter steps, defaulting to 15 meters.
- Added an enable/disable location-verification control.
- Added latitude, longitude, and radius validation before saving.
- Added saved-success and save-error feedback.
- Added reload support by reading the saved `location` object from the selected course.
- Added the required privacy notice.
- Added responsive styles consistent with the current dashboard.
- Added role checks in the UI and Firestore rules for instructor/admin writes.
- Added local Auth and Firestore emulator connections.
- Added HERE environment configuration without intentionally committing runtime credentials.
- Added unit tests for the location validation utilities.

## Sponsor feedback: replace radius buttons with a slider

The preset buttons have been replaced with a keyboard-accessible range slider from 1 to 15 meters in 1-meter steps, with a 15-meter default. A visible meter value and the HERE map circle update on every input event. Saved radii within the supported range are restored when selecting a course. Older out-of-range radii fall back to 15 meters in the editor; saving applies the new value.

Browser validation and the dashboard Firestore rules accept whole-number radii within these limits. Deploy the updated rules together with the dashboard to support intermediate values. Browser/emulator verification of mouse, touch, keyboard, save, and reload remains to be performed.

## Files involved

### New files

- `.env.example` — documents the required HERE environment variable. It must contain only a placeholder.
- `package.json` — dashboard build, validation, test, emulator, and deploy scripts.
- `public/course-settings.html` — Course Settings and Attendance Location page markup.
- `public/css/course-settings.css` — page-specific responsive styling.
- `public/js/course-location.js` — course loading, HERE map/search interaction, marker/radius state, authorization checks, and persistence.
- `public/js/course-location-utils.js` — reusable location normalization and validation helpers.
- `scripts/generate-runtime-config.js` — converts `HERE_API_KEY` into the ignored browser runtime configuration used by the static dashboard.
- `tests/course-location-utils.test.js` — location utility tests.
- `HERE_LOCATION_HANDOFF.md` — this handoff document.

### Modified files

- `.gitignore` — ignores `.env` and generated runtime configuration.
- `README.md` — documents setup, HERE configuration, emulator use, and the stored data shape.
- `firestore.rules` — adds role-based course writes and validates the location object.
- `public/js/firebase-client.js` — connects to Auth and Firestore emulators during local development.
- `public/js/sidebar-user.js` — adds Course Settings to the shared dashboard navigation.

## Course location data contract

The page merge-writes this field onto the selected `courses/{courseId}` document:

```js
location: {
  latitude: number,
  longitude: number,
  radiusMeters: number,
  addressLabel: string,
  enabled: boolean,
  updatedAt: timestamp,
  updatedBy: string
}
```

The slider, browser validation, and dashboard Firestore rules accept whole-number radii from 1 to 15 meters. Saving remains blocked if coordinates or radius are invalid, a course is not selected, or the signed-in profile does not have an authorized role.

## HERE API-key setup

1. Create a HERE project and a browser JavaScript API key.
2. Restrict the key to the required local and deployed web origins in the HERE project settings. Include the actual Firebase Hosting domain and the local host/port used for the demo.
3. In `FaceRoll-System/Instructor-Dashboard`, copy the example file:

   ```bash
   cp .env.example .env
   ```

4. Put the real value only in `.env`:

   ```dotenv
   HERE_API_KEY=your_real_key_here
   ```

5. Generate the runtime configuration:

   ```bash
   npm run build
   ```

Never place a real key in `.env.example`, source code, documentation, or a commit. A browser map key is necessarily delivered to the browser, so origin/domain restrictions are the main protection. Rotate any key that was previously placed in a tracked or shared file.

## Run the dashboard with Firebase emulators

Java 21 is installed in the current development environment. Verify the active version and then run:

```bash
cd FaceRoll-System/Instructor-Dashboard
java -version
npm install
cp .env.example .env
# Edit .env and add the real HERE_API_KEY before continuing.
npm run build
npm start
```

Expected local services:

- Dashboard: `http://127.0.0.1:5001`
- Firebase Emulator UI: `http://127.0.0.1:4000`
- Auth emulator: port `9099`
- Firestore emulator: port `8080`

Do not run the `cp` command if a correctly configured `.env` already exists, because it would overwrite the local configuration.

The emulators start with an empty database unless import/export is configured. For a fresh demo, register an instructor account, create a course from Live Session, and then open Course Settings.

## Verification completed

The following checks passed after the implementation was added:

- `npm run build`
- `npm run lint`
- `npm run typecheck`
- `npm test` — four location utility tests passed
- HTML validation with `xmllint`
- `git diff --check`

The emulator initially could not start because the machine was using Java 17. Java 21 is now installed. The initial sponsor demonstration was subsequently completed.

## Next instructor-dashboard work

1. Verify saved radii load correctly when switching courses and after a page refresh.
2. Test mouse, touch, and keyboard operation at common laptop sizes.
3. Run the Firebase emulator browser flow and deploy the updated rules with the dashboard.

## Remaining production work

### Instructor dashboard

- Add an automated browser test for search, selection, save, and reload.
- Add Firestore Rules emulator tests proving instructors/admins can write valid locations and unauthorized users cannot.
- Decide whether instructors may edit every course or only courses they own; enforce that ownership in both queries and Firestore rules.
- Move role assignment to trusted server-side administration or custom claims. The current profile-role approach is suitable for the prototype but should not be the final authorization boundary.
- Decide which Firestore rules file is authoritative for deployment if the repository contains more than one Firebase configuration. Deploying the wrong rules file could overwrite these protections.
- Configure emulator import/export if repeatable demo data is desired.
- Verify the HERE SDK version against the version approved for production before release.
- Add a direct Course Settings link from each course card if the team wants a faster course-management workflow.

## Known limitations and risks

- HERE map keys are visible to browser users by design, so the key must be restricted by allowed origins/domains.
- Local emulator data is temporary unless import/export is enabled.
- Authorization currently relies on the existing user-profile role model. Production role elevation must be controlled by trusted backend code.
- The final owner-scoping policy for courses has not yet been decided.

## Handoff definition of done

The next developer can consider the requested instructor-dashboard update complete when all of these are true:

- The HERE map loads with a restricted real key.
- Address search returns and selects a campus result.
- Map click and marker drag both update the location.
- The preset radius buttons have been replaced by one accessible slider.
- The selected meter value is always visible.
- Moving the slider immediately resizes the radius circle.
- The slider, validation utilities, Firestore rules, and tests use the same minimum, maximum, and step.
- The saved slider value is restored after switching courses or refreshing the page.
- Save succeeds for an instructor and persists after refresh.
- Invalid values are rejected.
- Unauthorized users cannot modify a course location.
- The page remains usable at a common laptop screen size.

All current repository changes are uncommitted. Review the diff and avoid committing `.env` or `public/js/runtime-config.js` when preparing a team handoff.

## Map availability update

Course Settings uses HERE Maps exclusively. Map labels use `lg: 'en'`, UI controls use `en-US`, and geocoding/reverse geocoding request English results. It checks vector-map access before initialization and explains missing credentials or rejected origins without changing providers.

The current key authorizes `http://127.0.0.1:5001` but rejects `http://127.0.0.1:5002` as an unauthorized source. Hosting on port 5002 requires adding that origin to the HERE key's trusted domains.

The shared dashboard stylesheet hides all images and SVGs. Course Settings overrides that rule inside the map so map controls and overlays remain visible.
