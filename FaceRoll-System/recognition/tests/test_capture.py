"""Exercise capture without opening a physical camera or GUI."""

import importlib.util
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


SOURCE = Path(__file__).resolve().parents[1] / 'windows' / 'capture.py'
SPEC = importlib.util.spec_from_file_location('faceroll_classroom_capture', SOURCE)
CAPTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.clean = object()
        self.frame = SimpleNamespace(copy=Mock(return_value=self.clean))
        self.camera = Mock()
        self.camera.isOpened.return_value = True
        self.camera.read.side_effect = [(True, self.frame), (False, None)]
        self.detector = Mock()
        self.detector.empty.return_value = False
        self.detector.detectMultiScale.return_value = [(10, 10, 40, 40)]

        def write_image(path, frame):
            self.assertIs(frame, self.clean, 'Recognition must receive the unannotated frame.')
            Path(path).write_bytes(b'synthetic-camera-frame')
            return True

        self.cv = SimpleNamespace(
            VideoCapture=Mock(return_value=self.camera), CascadeClassifier=Mock(return_value=self.detector),
            CAP_DSHOW=1, CAP_V4L2=2, CAP_PROP_FRAME_WIDTH=3, CAP_PROP_FRAME_HEIGHT=4,
            COLOR_BGR2GRAY=5, FONT_HERSHEY_SIMPLEX=6,
            data=SimpleNamespace(haarcascades='synthetic-models/'),
            resize=Mock(return_value=self.frame), cvtColor=Mock(return_value=self.frame),
            equalizeHist=Mock(return_value=self.frame), imwrite=Mock(side_effect=write_image),
            rectangle=Mock(), putText=Mock(), imshow=Mock(), waitKey=Mock(return_value=ord('q')),
            destroyAllWindows=Mock(),
        )
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(sys.modules, {'cv2': self.cv}))
        self.stack.enter_context(patch.dict(os.environ, {'FACEROLL_CAMERA_PREVIEW': '0'}))
        self.stack.enter_context(patch.object(CAPTURE, 'SHARED_DIR', self.root))
        self.stack.enter_context(patch.object(CAPTURE, 'IMAGE_PATH', self.root / 'input.jpg'))
        self.stack.enter_context(patch.object(CAPTURE, 'PENDING_IMAGE_PATH', self.root / 'input.pending.jpg'))
        self.stack.enter_context(patch.object(CAPTURE.time, 'time', return_value=100))

    def test_default_capture_writes_clean_frames_without_any_gui_calls(self):
        self.assertEqual(CAPTURE.main([]), 0)
        self.assertEqual((self.root / 'input.jpg').read_bytes(), b'synthetic-camera-frame')
        self.assertFalse((self.root / 'input.pending.jpg').exists())
        for name in ('imshow', 'waitKey', 'rectangle', 'putText', 'destroyAllWindows'):
            getattr(self.cv, name).assert_not_called()
        self.camera.release.assert_called_once()

    def test_preview_flag_keeps_debug_window_and_quit_with_clean_handoff(self):
        self.assertEqual(CAPTURE.main(['--preview']), 0)
        self.cv.imshow.assert_called_once()
        self.cv.waitKey.assert_called_once()
        self.cv.destroyAllWindows.assert_called_once()
        self.camera.release.assert_called_once()
        self.assertTrue((self.root / 'input.jpg').exists())

    def test_inherited_preview_setting_allows_debug_manual_capture(self):
        self.detector.detectMultiScale.return_value = []
        self.cv.waitKey.return_value = ord(' ')
        with patch.dict(os.environ, {'FACEROLL_CAMERA_PREVIEW': '1'}):
            self.assertEqual(CAPTURE.main([]), 0)
        self.assertTrue((self.root / 'input.jpg').exists())
        self.camera.release.assert_called_once()
        self.cv.destroyAllWindows.assert_called_once()

    def test_standalone_interrupt_releases_camera_without_gui(self):
        self.camera.read.side_effect = KeyboardInterrupt
        self.assertEqual(CAPTURE.main([]), 0)
        self.camera.release.assert_called_once()
        self.cv.destroyAllWindows.assert_not_called()

    def test_capture_error_still_releases_camera(self):
        self.camera.read.side_effect = RuntimeError('Synthetic camera error')
        with self.assertRaises(RuntimeError):
            CAPTURE.main([])
        self.camera.release.assert_called_once()

    def test_unavailable_camera_releases_handle_and_does_not_open_window(self):
        self.camera.isOpened.return_value = False
        self.assertEqual(CAPTURE.main([]), 1)
        self.camera.release.assert_called_once()
        self.cv.imshow.assert_not_called()
