"""Exercise the showcase playback (lib.showcase_animation) without solved routes or a CAD build.

A held keyframe must keep its exact numbers: the weighted sum can round equal
endpoints differently as alpha advances, which would move a cord or a finger
whose mechanism has not moved. A moving one keeps the plain linear blend, and
the clips read the timeline they were given, not a stale copy of it.
"""
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from lib.showcase_animation import interpolate, showcase_clips  # noqa: E402

HELD = [10.123456, 10.234567, 10.345678]
TIMELINE = {
    'frames': {'index_pip': ['phalanx']}, 'actuatorBodies': {}, 'hiddenBodies': [], 'guides': [],
    'ropeNames': ['cord'], 'ropeNormals': [[0, 0, 1]], 'ropeTemplates': [['bezier']],
    'ropeBase': [[0, 0, 0, 10, 0, 0, 10, 10, 0, 20, 10, 0]], 'ropeVarying': [[3, 7, 10]],
    'motions': [{'id': 'hold', 'label': 'Hold', 'seconds': 1.0}],
    'keyframes': [{'t': 0.0, 'pose': {'index_pip': 10.1}, 'q': [], 'v': list(HELD), 'g': []},
                  {'t': 1.0, 'pose': {'index_pip': 10.1}, 'q': [], 'v': list(HELD), 'g': []}],
}


class Recorder:
    """The `m` a clip receives, keeping what it was told."""

    def __init__(self):
        self.seen = {}

    def get(self, *targets):
        recorder = self

        class Handle:
            def transform(self, matrix):
                recorder.seen[('transform', targets)] = [[float(v) for v in row] for row in matrix]
                return self

            def deform_tube(self, **spec):
                recorder.seen[('tube', targets)] = json.loads(json.dumps(spec))
                return self
        return Handle()


def play(clips, t):
    m = Recorder()
    clips['hold'].update(t, m)
    return m.seen


def main():
    for value in (0, 0.1, -0.1, 123.456789, -234.567891):
        assert all(interpolate(value, value, step / 1000) == value for step in range(1001))
    for low, high in ((0.1, 0.2), (-234.567891, 123.456789), (4, -8)):
        alphas = [step / 1000 for step in range(1001)]
        assert all(interpolate(low, high, alpha) == low * (1 - alpha) + high * alpha for alpha in alphas)
    timeline = copy.deepcopy(TIMELINE)
    clips = showcase_clips(timeline)
    first = play(clips, 0)
    assert first[('tube', ('#cord',))]['path']['segments'][0]['points'][1] == [HELD[0], 0, 0]
    assert ('transform', ('#phalanx',)) in first
    for step in range(101):
        assert play(clips, step / 100) == first, f'a held keyframe moved at t={step / 100}'
    timeline['keyframes'][1]['v'][0] += 1
    assert play(clips, 0.5) != first, 'the clip did not see its timeline change'
    assert play(clips, 0) == first
    print('SHOWCASE PLAYBACK PASS')


if __name__ == '__main__':
    main()
