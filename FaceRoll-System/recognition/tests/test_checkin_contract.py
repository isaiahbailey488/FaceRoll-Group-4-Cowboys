import copy
import json
from pathlib import Path

import pytest
from faceroll_recognition.checkin_contract import CheckInContractError, validate_check_in_request, validate_check_in_success
from faceroll_recognition.runtime_config import firebase_environment

FIXTURE = json.loads((Path(__file__).resolve().parents[3] / 'shared' / 'checkin-contract.cases.json').read_text())


def test_shared_request_contract_preserves_input_and_allows_explicit_null():
    request = copy.deepcopy(FIXTURE['request'])
    assert validate_check_in_request({**request, 'image': None})['image'] is None
    normalized = validate_check_in_request(request)
    assert normalized == request
    assert normalized['location'] is not request['location']
    assert validate_check_in_request({**request, 'location': None})['location'] is None
    for key in request:
        incomplete = dict(request)
        del incomplete[key]
        with pytest.raises(CheckInContractError):
            validate_check_in_request(incomplete)


@pytest.mark.parametrize('case', FIXTURE['invalidRequests'], ids=lambda case: case['name'])
def test_shared_rejection_cases(case):
    request = copy.deepcopy(FIXTURE['request'])
    target = request
    for part in case['path'][:-1]:
        target = target[part]
    target[case['path'][-1]] = case['value']
    with pytest.raises(CheckInContractError, match='^Invalid check-in payload.$'):
        validate_check_in_request(request)


def test_nonfinite_and_huge_numbers_are_rejected_without_input_in_errors():
    for value in (float('nan'), float('inf'), -(10 ** 400), 10 ** 400):
        request = copy.deepcopy(FIXTURE['request'])
        request['location']['latitude'] = value
        with pytest.raises(CheckInContractError):
            validate_check_in_request(request)


def test_success_response_never_echoes_position_or_photo():
    assert validate_check_in_success(FIXTURE['success']) == FIXTURE['success']
    for extra in ({'image': FIXTURE['request']['image']}, {'location': FIXTURE['request']['location']}, {'locationStatus': 'outside_zone'}):
        with pytest.raises(CheckInContractError):
            validate_check_in_success({**FIXTURE['success'], **extra})


def test_backend_environments_fail_closed_when_mixed_or_incomplete():
    emulator = {'FACEROLL_FIREBASE_MODE': 'emulator', 'FIREBASE_PROJECT_ID': 'demo-test',
                'FIREBASE_AUTH_EMULATOR_HOST': '127.0.0.1:9099', 'FIRESTORE_EMULATOR_HOST': '127.0.0.1:8080'}
    assert firebase_environment(emulator) == 'emulator'
    assert firebase_environment({'FACEROLL_FIREBASE_MODE': 'production'}) == 'production'
    for invalid in ({**emulator, 'FACEROLL_FIREBASE_MODE': 'production'},
                    {**emulator, 'FIRESTORE_EMULATOR_HOST': ''},
                    {**emulator, 'FIREBASE_PROJECT_ID': ''},
                    {'FACEROLL_FIREBASE_MODE': 'invalid'}):
        with pytest.raises(ValueError):
            firebase_environment(invalid)
