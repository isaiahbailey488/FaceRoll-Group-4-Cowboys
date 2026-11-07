"""The future check-in boundary. No persistence or biometric processing here."""
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = json.loads(Path(__file__).with_name('checkin.schema.json').read_text(encoding='utf-8'))


class CheckInContractError(ValueError):
    code = 'invalid_check_in_request'

    def __init__(self):
        super().__init__('Invalid check-in payload.')


def _finite(value):
    try:
        return math.isfinite(value)
    except (OverflowError, TypeError):
        return False


def _validate(value, spec):
    actual = 'null' if value is None else 'boolean' if type(value) is bool else 'number' if type(value) in (int, float) else 'string' if type(value) is str else 'object' if type(value) is dict else 'array'
    accepted = spec['type'] if isinstance(spec['type'], list) else [spec['type']]
    if actual not in accepted and not (actual == 'number' and 'integer' in accepted and _finite(value) and float(value).is_integer() and abs(value) <= 9007199254740991):
        raise CheckInContractError()
    if 'enum' in spec and value not in spec['enum']:
        raise CheckInContractError()
    if value is None:
        return None
    if actual == 'object':
        if any(key not in value for key in spec.get('required', [])) or any(key not in spec['properties'] for key in value):
            raise CheckInContractError()
        return {key: _validate(item, spec['properties'][key]) for key, item in value.items()}
    if actual == 'number' and (not _finite(value) or value < spec.get('minimum', -math.inf) or value > spec.get('maximum', math.inf)):
        raise CheckInContractError()
    if actual == 'string':
        if len(value) < spec.get('minLength', 0) or len(value) > spec.get('maxLength', math.inf) or ('pattern' in spec and not re.fullmatch(spec['pattern'], value)):
            raise CheckInContractError()
        if spec.get('format') == 'base64' and (len(value) % 4 or not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', value)):
            raise CheckInContractError()
        if spec.get('format') == 'utc-milliseconds':
            try:
                parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
                valid = parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z') == value
            except (ValueError, OverflowError):
                valid = False
            if not valid:
                raise CheckInContractError()
    return value


def validate_check_in_request(value):
    return _validate(value, SCHEMA['$defs']['request'])


def validate_check_in_success(value):
    return _validate(value, SCHEMA['$defs']['success'])
