#!/usr/bin/env python3
"""Merge read-only PRiSM/ArcadeLink SQLite snapshots into a NEW local database.

Usage: python3 scripts/merge-platform.py manifest.json output.sqlite
The manifest explicitly maps each billing snapshot to an existing ArcadeLink shop.
No network access, deployment, or writes to source snapshots.
"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def tables(db):
    return [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") if row[0] not in ('d1_migrations', '_cf_KV')]


def columns(db, table):
    return [row[1] for row in db.execute('PRAGMA table_info(' + quote(table) + ')')]


def snapshot(path):
    source = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    copy = sqlite3.connect(':memory:')
    source.backup(copy)
    source.close()
    copy.execute('PRAGMA foreign_keys=ON')
    return copy


def digest(db, table, names, shop_id=None):
    names = sorted(names)
    query = 'SELECT ' + ','.join(map(quote, names)) + ' FROM ' + quote(table)
    values = ()
    if shop_id is not None:
        query += ' WHERE shop_id=?'
        values = (shop_id,)
    rows = [json.dumps(list(row), ensure_ascii=False, separators=(',', ':'), default=lambda value: {'blob': value.hex()}) for row in db.execute(query, values)]
    return len(rows), hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()


def legacy_device_report(db, shop_id):
    """Report old HA registry rows that still need logical-device import."""
    row = db.execute(
        'SELECT value_json FROM app_settings WHERE shop_id=? AND key=?',
        (shop_id, 'devices.homeassistant'),
    ).fetchone()
    logical = db.execute('SELECT COUNT(*) FROM machines WHERE shop_id=?', (shop_id,)).fetchone()[0]
    result = {'legacyHomeAssistant': 0, 'logicalDevices': logical}
    if row is None:
        return result
    try:
        devices = json.loads(row[0])
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError('Invalid devices.homeassistant JSON for shop ' + shop_id) from error
    if not isinstance(devices, list):
        raise ValueError('devices.homeassistant must be an array for shop ' + shop_id)
    result['legacyHomeAssistant'] = len(devices)
    if devices and logical == 0:
        result['requiresFollowUp'] = 'Run scripts/import-legacy-devices.ts before production cutover.'
    elif devices and logical != len(devices):
        result['requiresFollowUp'] = 'Review the logical-device mapping before production cutover.'
    return result


def merge(manifest, output):
    output = Path(output).resolve()
    if output.exists():
        raise ValueError('Output already exists; choose a new path')
    billing = manifest['billing']
    if not billing or len({item['shopId'] for item in billing}) != len(billing):
        raise ValueError('Each billing snapshot requires a distinct explicit shopId')
    arcade = snapshot(manifest['arcadelink'])
    shop_ids = {row[0] for row in arcade.execute('SELECT id FROM shops')}
    if any(item['shopId'] not in shop_ids for item in billing):
        raise ValueError('A mapped shopId does not exist in the ArcadeLink snapshot')
    first = snapshot(billing[0]['database'])
    billing_tables = tables(first)
    if len(billing_tables) != 29 or 'auth_sessions' in billing_tables:
        raise ValueError('Expected a PRiSM billing snapshot before platform merge')
    if 'shop_id' in columns(first, 'players'):
        raise ValueError('Source is already tenant-scoped; use the original snapshot')
    fd, temporary = tempfile.mkstemp(prefix='.prism-merge-', suffix='.sqlite', dir=output.parent)
    os.close(fd)
    target = sqlite3.connect(temporary)
    report = {'billing': [], 'platform': {}, 'foreignKeyErrors': 0}
    try:
        first.backup(target)
        target.execute('PRAGMA foreign_keys=ON')
        target.executescript((ROOT / 'migrations/0016_shop_scoped_billing.sql').read_text())
        target.executescript((ROOT / 'migrations/0017_platform_accounts.sql').read_text())
        target.execute('BEGIN')
        target.execute('PRAGMA defer_foreign_keys=ON')
        for table in tables(arcade):
            destination = 'auth_sessions' if table == 'sessions' else table
            names = columns(arcade, table)
            if set(names) != set(columns(target, destination)):
                raise ValueError('ArcadeLink schema differs for ' + table)
            target.executemany('INSERT INTO ' + quote(destination) + '(' + ','.join(map(quote, names)) + ') VALUES (' + ','.join('?' for _ in names) + ')', arcade.execute('SELECT ' + ','.join(map(quote, names)) + ' FROM ' + quote(table)))
            expected = digest(arcade, table, names)
            if digest(target, destination, names) != expected:
                raise ValueError('Platform data verification failed for ' + table)
            report['platform'][destination] = expected[0]
        # Location checks are opt-in. The owner enables them after reviewing the imported shop.
        target.execute('INSERT INTO shop_billing_settings(shop_id) SELECT id FROM shops')
        for index, item in enumerate(billing):
            source = first if index == 0 else snapshot(item['database'])
            shop_id = item['shopId']
            counts = {}
            if tables(source) != billing_tables:
                raise ValueError('Billing schemas have different table sets')
            for table in billing_tables:
                names = columns(source, table)
                if set(names) != set(columns(target, table)) - {'shop_id'}:
                    raise ValueError('Billing schema differs for ' + table)
                if index == 0:
                    target.execute('UPDATE ' + quote(table) + ' SET shop_id=? WHERE shop_id=\'legacy\'', (shop_id,))
                else:
                    query = 'INSERT INTO ' + quote(table) + '(shop_id,' + ','.join(map(quote, names)) + ') VALUES (' + ','.join('?' for _ in range(len(names) + 1)) + ')'
                    target.executemany(query, ((shop_id,) + tuple(row) for row in source.execute('SELECT ' + ','.join(map(quote, names)) + ' FROM ' + quote(table))))
                expected = digest(source, table, names)
                if digest(target, table, names, shop_id) != expected:
                    raise ValueError('Billing data verification failed for ' + table)
                counts[table] = expected[0]
            # Billing is enabled only after an owner reviews Bot credentials, pricing and the three location flags.
            report['billing'].append({'shopId': shop_id, 'tables': counts})
            if index:
                source.close()
        for mapping in manifest.get('staffAccounts', []):
            shop_id, user_id, staff_id = mapping['shopId'], mapping['userId'], mapping['staffId']
            if not target.execute('SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=?', (shop_id, user_id)).fetchone():
                raise ValueError('Staff account must already be a member of the mapped shop')
            target.execute('INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES (?,?,?)', (shop_id, user_id, staff_id))
        errors = list(target.execute('PRAGMA foreign_key_check'))
        if errors:
            raise ValueError('Foreign-key verification failed (%d errors)' % len(errors))
        if target.execute("SELECT 1 FROM sqlite_master WHERE name='d1_migrations'").fetchone():
            for name in ('0016_shop_scoped_billing.sql', '0017_platform_accounts.sql'):
                target.execute('INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)', (name,))
        target.commit()
        for migration in sorted((ROOT / 'migrations').glob('*.sql')):
            if migration.name < '0018_':
                continue
            target.executescript(migration.read_text())
            if target.execute("SELECT 1 FROM sqlite_master WHERE name='d1_migrations'").fetchone():
                target.execute("INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)", (migration.name,))
        report['migrations'] = [p.name for p in sorted((ROOT / 'migrations').glob('*.sql')) if p.name >= '0016_']
        report['unifiedDevices'] = target.execute('SELECT COUNT(*) FROM machines').fetchone()[0]
        report['legacyDeviceRegistries'] = []
        for item in report['billing']:
            device_report = legacy_device_report(target, item['shopId'])
            item['devices'] = device_report
            if device_report.get('requiresFollowUp'):
                report['legacyDeviceRegistries'].append({
                    'shopId': item['shopId'],
                    **device_report,
                })
        errors = list(target.execute('PRAGMA foreign_key_check'))
        report['foreignKeyErrors'] = len(errors)
        if errors:
            raise ValueError('Foreign-key verification failed after device migration (%d errors)' % len(errors))
        integrity = target.execute('PRAGMA integrity_check').fetchone()[0]
        report['integrity'] = integrity
        if integrity != 'ok':
            raise ValueError('SQLite integrity check failed: ' + str(integrity))
        target.commit()
        target.close()
        # Atomic creation, refusing to replace a file created while we were running.
        os.link(temporary, output)
        return report
    finally:
        target.close()
        first.close()
        arcade.close()
        Path(temporary).unlink(missing_ok=True)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    try:
        manifest_path = Path(sys.argv[1]).resolve()
        manifest = json.loads(manifest_path.read_text())
        manifest['arcadelink'] = str(manifest_path.parent / manifest['arcadelink'])
        for item in manifest['billing']:
            item['database'] = str(manifest_path.parent / item['database'])
        report = merge(manifest, sys.argv[2])
        print(json.dumps(report, indent=2))
    except (ValueError, KeyError, sqlite3.Error, OSError) as error:
        raise SystemExit('Merge failed: ' + str(error))
