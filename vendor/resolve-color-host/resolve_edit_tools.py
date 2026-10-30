"""Bounded Resolve edit maintenance. No project creation, selection or implicit targets."""
import base64
import math
import os
import sys
import time
import uuid
from pathlib import Path

# Copy only these Inspector attributes. No audio, grade, plugins, Fusion or retiming.
ATTRIBUTES = {
    'position': ('Pan', 'Tilt'), 'rotationAngle': ('RotationAngle',),
    'scaleX': ('ZoomX',), 'scaleY': ('ZoomY',),
    'anchorPoint': ('AnchorPointX', 'AnchorPointY'), 'opacity': ('Opacity',),
    'pitch': ('Pitch',), 'yaw': ('Yaw',), 'flipV': ('FlipY',), 'flipH': ('FlipX',),
    'cropLeft': ('CropLeft',), 'cropRight': ('CropRight',),
    'cropTop': ('CropTop',), 'cropBottom': ('CropBottom',),
    'cropSoftness': ('CropSoftness',), 'retainImagePosition': ('CropRetain',),
}
MINIMUMS = {'selection': (21, 0, 4), 'speed': (21, 1, 0), 'fades': (21, 1, 0),
            'transition': (21, 1, 0), 'copy-video-attributes': (21, 1, 2), 'frame': (21, 1, 2)}


def capabilities(h, resolve):
    version, parts, warnings = h.get_resolve_version_info(resolve)
    normalized = tuple((list(parts or ()) + [0, 0, 0])[:3])
    if sys.platform == 'darwin':
        root = Path('/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting')
    elif sys.platform == 'win32':
        root = Path(os.environ.get('PROGRAMDATA', 'C:/ProgramData')) / 'Blackmagic Design/DaVinci Resolve/Support/Developer/Scripting'
    else:
        root = Path('/opt/resolve/Developer/Scripting')
    return {'version': version, 'warnings': warnings,
            'documentation': [str(root / name) for name in ('README.md', 'DaVinciResolveScript.pyi', 'CHANGELOG.md', 'README.txt') if (root / name).is_file()],
            'capabilities': {key: {'minimumVersion': '.'.join(map(str, minimum)),
                                   'documentedForVersion': bool(parts) and normalized >= minimum,
                                   'executionVerified': False} for key, minimum in MINIMUMS.items()},
            'subtitles': {'readText': 'GetName', 'moveExisting': 'SetPosition (verified on 21.1.2)',
                          'writeText': 'No verified public API; SetName returned False on 21.1.2',
                          'createFromText': 'No verified public API',
                          'transcriptionIsSubtitleText': False}}


def require_feature(h, resolve, feature):
    if not capabilities(h, resolve)['capabilities'][feature]['documentedForVersion']:
        raise h.HostError('resolve_edit_capability_missing', f'{feature} requires Resolve {MINIMUMS[feature]}.')


def inventory(h, timeline):
    rows = []
    for kind in ('video', 'audio', 'subtitle'):
        for track in range(1, timeline.GetTrackCount(kind) + 1):
            for item in h.iter_values(timeline.GetItemListInTrack(kind, track)):
                rows.append((item, {'id': item.GetUniqueId(), 'name': item.GetName(), 'itemType': h.safe_call(item, 'GetType'),
                    'trackType': kind, 'trackIndex': track, 'startFrame': item.GetStart(), 'endFrame': item.GetEnd()}))
    return rows


def require_target(h, resolve, payload):
    project = resolve.GetProjectManager().GetCurrentProject()
    if not payload.get('resolveProjectName') or not project or project.GetName() != payload['resolveProjectName']:
        raise h.HostError('resolve_edit_project_mismatch', 'Open the explicitly named existing project first.')
    if not payload.get('timelineName'):
        raise h.HostError('resolve_edit_timeline_missing', 'An explicit timeline name is required.')
    timeline = h.require_existing_edit_timeline(project, payload['timelineName'])
    if payload.get('timelineId') and timeline.GetUniqueId() != payload['timelineId']:
        raise h.HostError('resolve_edit_timeline_mismatch', 'Timeline id does not match the inspected target.')
    return project, timeline


def require_current(h, resolve, project, timeline):
    current_project = resolve.GetProjectManager().GetCurrentProject()
    current = current_project.GetCurrentTimeline() if current_project else None
    if not current_project or current_project.GetUniqueId() != project.GetUniqueId() or not current or current.GetUniqueId() != timeline.GetUniqueId():
        raise h.HostError('resolve_edit_current_mismatch', 'The explicit project/timeline must still be current.')


def integer(h, value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise h.HostError('resolve_edit_invalid_input', f'{name} must be an integer >= {minimum}.')
    return value


def export_frame(h, timeline, payload):
    offset = integer(h, payload.get('frameOffset'), 'frameOffset')
    dimension = integer(h, payload.get('maxDimension', 1280), 'maxDimension', 1)
    if dimension > 4096 or offset >= timeline.GetEndFrame() - timeline.GetStartFrame():
        raise h.HostError('resolve_edit_invalid_input', 'Frame must lie inside the timeline; maxDimension must be <= 4096.')
    fmt = payload.get('format', 'png')
    if fmt not in ('png', 'jpg'):
        raise h.HostError('resolve_edit_invalid_input', 'Frame format must be png or jpg.')
    target = Path(payload['outputPath']).expanduser().absolute() if payload.get('outputPath') else None
    if target and (target.exists() or target.is_symlink() or not target.parent.is_dir() or target.suffix.lower() not in (('.png',) if fmt == 'png' else ('.jpg', '.jpeg'))):
        raise h.HostError('resolve_edit_output_exists', 'Use a new image path with a matching extension in an existing directory.', {'path': str(target)})
    result = timeline.ExportFrame(offset, {'outputType': 'encodedString', 'encodedImageFormat': fmt, 'maxDimension': dimension})
    if not isinstance(result, dict) or result.get('success') is not True or not result.get('data'):
        raise h.HostError('resolve_edit_frame_failed', 'Resolve frame export failed.', {'error': result.get('error') if isinstance(result, dict) else None})
    if target:
        encoded = result['data'].split(',', 1)[-1]
        data = base64.b64decode(encoded, validate=True)
        signature = b'\x89PNG\r\n\x1a\n' if fmt == 'png' else b'\xff\xd8'
        if not data.startswith(signature):
            raise h.HostError('resolve_edit_frame_failed', 'Resolve returned an invalid encoded image.')
        # Exclusive creation also prevents races and symlink replacement.
        with target.open('xb') as stream:
            stream.write(data)
        return {'success': True, 'outputPath': str(target), 'bytes': len(data), 'frameOffset': offset}
    return {**result, 'frameOffset': offset, 'format': fmt}


def execute(h, resolve, payload):
    action = payload.get('action')
    if action == 'capabilities':
        return capabilities(h, resolve)
    if action not in ('inspect', 'frame', 'fades', 'transition', 'copy-video-attributes'):
        raise h.HostError('resolve_edit_invalid_action', f'Unknown edit action: {action}')
    project, timeline = require_target(h, resolve, payload)
    identity = {'resolveProjectName': project.GetName(), 'timelineName': timeline.GetName(), 'timelineId': timeline.GetUniqueId()}
    if action == 'frame':
        require_feature(h, resolve, action)
        require_current(h, resolve, project, timeline)
        return {**identity, **export_frame(h, timeline, payload)}
    rows = inventory(h, timeline)
    if action == 'inspect':
        require_feature(h, resolve, 'selection')
        require_current(h, resolve, project, timeline)
        selection = timeline.GetSelectedClips()
        if not isinstance(selection, (dict, list, tuple)):
            raise h.HostError('resolve_edit_selection_failed', 'Resolve did not return a valid selection list.')
        selected = {item.GetUniqueId() for item in h.iter_values(selection)}
        return {**identity, 'items': [{**row, 'selected': row['id'] in selected} for _, row in rows],
                'selectedItemIds': sorted(selected), 'selectionScope': 'timeline.GetSelectedClips'}
    require_feature(h, resolve, action)
    if not payload.get('timelineId'):
        raise h.HostError('resolve_edit_identity_required', 'Inspect first and supply timelineId for video maintenance.')
    require_current(h, resolve, project, timeline)
    item_ids = payload.get('itemIds')
    if not isinstance(item_ids, list) or not item_ids or any(not isinstance(x, str) or not x for x in item_ids) or len(set(item_ids)) != len(item_ids):
        raise h.HostError('resolve_edit_targets_required', 'Supply unique explicit itemIds; no implicit all-clips selection.')
    by_id = {row['id']: (item, row) for item, row in rows}
    if len(by_id) != len(rows):
        raise h.HostError('resolve_edit_ambiguous_items', 'Timeline has duplicate item identities.')
    source_id = payload.get('sourceId') if action == 'copy-video-attributes' else None
    if action == 'copy-video-attributes' and (not source_id or source_id in item_ids):
        raise h.HostError('resolve_edit_source_required', 'Supply a distinct explicit sourceId.')
    for item_id in [*item_ids, *([source_id] if source_id else [])]:
        if item_id not in by_id or by_id[item_id][1]['trackType'] != 'video' or by_id[item_id][1]['itemType'] == 'transition':
            raise h.HostError('resolve_edit_video_only', 'Every target/source must be an existing video item.', {'itemId': item_id})
        row = by_id[item_id][1]
        if timeline.GetIsTrackLocked('video', row['trackIndex']) is not False:
            raise h.HostError('resolve_edit_track_locked', 'Unlock the explicit video track before maintenance.')
    targets = [by_id[item_id] for item_id in item_ids]
    expected = {}
    if action == 'fades':
        options = {key: integer(h, payload.get(key), key) for key in ('FadeIn', 'FadeOut')}
        for _, row in targets:
            if sum(options.values()) > row['endFrame'] - row['startFrame']:
                raise h.HostError('resolve_edit_invalid_input', 'Video fades cannot exceed the clip duration.')
    elif action == 'transition':
        position = payload.get('position')
        if position not in ('start', 'end') or payload.get('type', 'Cross Dissolve') != 'Cross Dissolve':
            raise h.HostError('resolve_edit_invalid_input', 'Only explicit start/end Cross Dissolve is currently supported.')
        options = {'type': 'Cross Dissolve', 'category': 'simple', 'position': position,
                   'alignment': 'right' if position == 'start' else 'left',
                   'duration': integer(h, payload.get('duration'), 'duration', 1)}
        for _, row in targets:
            if options['duration'] > row['endFrame'] - row['startFrame']:
                raise h.HostError('resolve_edit_invalid_input', 'Transition must fit within the target clip.')
    else:
        attrs = payload.get('attributes')
        if not isinstance(attrs, list) or not attrs or any(not isinstance(key, str) or key not in ATTRIBUTES for key in attrs):
            raise h.HostError('resolve_edit_attributes_invalid', 'Choose explicit whitelisted video Inspector attributes.', {'allowed': sorted(ATTRIBUTES)})
        options = {key: True for key in attrs}
        source = by_id[source_id][0]
        properties = source.GetProperties() or {}
        for key in attrs:
            for prop in ATTRIBUTES[key]:
                if prop not in properties:
                    raise h.HostError('resolve_edit_property_missing', f'Cannot validate source property {prop}.')
                expected[prop] = properties[prop]
    plan = {**identity, 'action': action, 'targets': [row for _, row in targets], 'sourceId': source_id, 'options': options}
    if payload.get('apply') is not True:
        return {**plan, 'applied': False, 'dryRun': True}
    # Persist a recovery copy before touching any item. Keep it on success and
    # failure; deleting/replacing the original timeline would invalidate item IDs.
    backup = timeline.DuplicateTimeline('Kairos recovery ' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    if not backup:
        raise h.HostError('resolve_edit_backup_failed', 'Could not create a recovery timeline; no edits applied.')
    recovery = {'timelineName': backup.GetName(), 'timelineId': backup.GetUniqueId()}
    created_transitions = []
    try:
        # DuplicateTimeline selects the new copy on 21.1.2. Restore only when
        # the current timeline is our own copy, never override a user's switch.
        current = project.GetCurrentTimeline()
        if current and current.GetUniqueId() == backup.GetUniqueId():
            if project.SetCurrentTimeline(timeline) is not True:
                raise h.HostError('resolve_edit_current_mismatch', 'Could not restore the explicit target after creating its recovery copy.')
        require_current(h, resolve, project, timeline)
        if resolve.GetProjectManager().SaveProject() is not True:
            raise h.HostError('resolve_edit_save_failed', 'Could not persist recovery timeline; no edits applied.')
        require_current(h, resolve, project, timeline)
        if action == 'copy-video-attributes' and source.CopyAttributes([item for item, _ in targets], options) is not True:
            raise h.HostError('resolve_edit_copy_failed', 'CopyAttributes failed.')
        for item, row in targets:
            require_current(h, resolve, project, timeline)
            if timeline.GetIsTrackLocked('video', row['trackIndex']) is not False:
                raise h.HostError('resolve_edit_track_locked', 'Target track became locked during maintenance.')
            if action == 'fades':
                if item.SetFades(options) is not True or item.GetFades() != options:
                    raise h.HostError('resolve_edit_validation_failed', 'Video fade readback failed.', row)
            elif action == 'transition':
                transition = item.AddTransition(options)
                props = transition.GetProperties() if transition else {}
                if not transition or any(props.get(key) != val for key, val in {
                    'TransitionType': options['type'], 'TransitionCategory': options['category'],
                    'TransitionDuration': options['duration'], 'TransitionAlignment': options['alignment']}.items()):
                    raise h.HostError('resolve_edit_validation_failed', 'Transition readback failed.', row)
                created_transitions.append(transition.GetUniqueId())
            else:
                props = item.GetProperties() or {}
                for prop, value in expected.items():
                    actual = props.get(prop)
                    same = math.isclose(actual, value, abs_tol=1e-5) if isinstance(actual, (int, float)) and isinstance(value, (int, float)) else actual == value
                    if not same:
                        raise h.HostError('resolve_edit_validation_failed', f'Copied property {prop} did not match source; animated attributes may require manual verification.', row)
        # Resolve includes the newly created transition items in track inventory.
        # Permit exactly those additions while retaining every pre-existing item.
        after_rows = [row for _, row in inventory(h, timeline)]
        added = set(created_transitions) - set(by_id)
        if sorted((row['id'], row['startFrame'], row['endFrame']) for row in after_rows if row['id'] not in added) != sorted((row['id'], row['startFrame'], row['endFrame']) for _, row in rows):
            raise h.HostError('resolve_edit_validation_failed', 'Maintenance unexpectedly changed timeline item positions.')
        if resolve.GetProjectManager().SaveProject() is not True:
            raise h.HostError('resolve_edit_save_failed', 'Could not save the validated maintenance result.')
        return {**plan, 'applied': True, 'recovery': recovery, 'createdTransitionIds': created_transitions}
    except Exception as error:
        raise h.HostError('resolve_edit_failed_with_recovery', str(error), {'recovery': recovery, 'partialChangesPossible': True}) from error
