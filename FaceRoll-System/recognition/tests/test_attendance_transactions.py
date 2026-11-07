"""Bounded recovery for confirmed Firestore aborts, not uncertain failures."""
import unittest
from unittest.mock import Mock, patch

from google.api_core.exceptions import Aborted, DeadlineExceeded, PermissionDenied

from faceroll_recognition.attendance import firebase_attendance_boundary


class AttendanceTransactionRetryTests(unittest.TestCase):
    def boundary(self, executor):
        client = Mock()
        client.transaction.side_effect = lambda: object()
        patches = [
            patch('faceroll_recognition.mobile_api._firestore_client', return_value=client),
            patch('firebase_admin.firestore.transactional', return_value=executor),
            patch('faceroll_recognition.attendance.random.uniform', return_value=0.05),
            patch('faceroll_recognition.attendance.time.sleep'),
        ]
        handles = [item.start() for item in patches]
        for item in patches:
            self.addCleanup(item.stop)
        self.assertIs(firebase_attendance_boundary()[0], client)
        return client, firebase_attendance_boundary()[1], handles[-1]

    def test_aborted_read_retries_with_fresh_transaction(self):
        transactions = []
        def execute(transaction):
            transactions.append(transaction)
            if len(transactions) == 1:
                raise Aborted('Synthetic read contention')
            return 'accepted'
        client, transact, sleep = self.boundary(execute)
        self.assertEqual(transact(Mock()), 'accepted')
        self.assertEqual(client.transaction.call_count, 2)
        self.assertIsNot(transactions[0], transactions[1])
        sleep.assert_called_once_with(0.05)

    def test_sdk_exhausted_abort_retries_without_replaying_face_inference(self):
        exhausted = ValueError('SDK retries exhausted')
        exhausted.__cause__ = Aborted('Synthetic contention')
        executor = Mock(side_effect=[exhausted, {'duplicate': True}])
        client, transact, sleep = self.boundary(executor)
        # This boundary receives only the final transaction callback. Inference
        # remains outside it, as exercised by the check-in transaction tests.
        self.assertEqual(transact(Mock()), {'duplicate': True})
        self.assertEqual(client.transaction.call_count, 2)
        sleep.assert_called_once()

    def test_repeated_aborts_stop_after_three_fresh_transactions(self):
        executor = Mock(side_effect=Aborted('Synthetic contention'))
        client, transact, sleep = self.boundary(executor)
        with self.assertRaises(Aborted):
            transact(Mock())
        self.assertEqual(client.transaction.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.05, 0.10])

    def test_permission_application_and_uncertain_transport_errors_are_not_replayed(self):
        for error in (PermissionDenied('Synthetic denied'), DeadlineExceeded('Synthetic unknown outcome'), ValueError('Application error')):
            with self.subTest(error=type(error).__name__):
                executor = Mock(side_effect=error)
                client, transact, sleep = self.boundary(executor)
                with self.assertRaises(type(error)) as raised:
                    transact(Mock())
                self.assertIs(raised.exception, error)
                self.assertEqual(client.transaction.call_count, 1)
                sleep.assert_not_called()
