// Copyright (C) 2026 Dominik Boehi
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {TrackNode} from '../../public/workspace';
import {
  CaptureTrackVisibility,
  type HiddenTracks,
  type HiddenTracksStore,
  withHideButton,
} from './visibility';

class MemoryStore implements HiddenTracksStore {
  value: HiddenTracks = {};
  get() {
    return this.value;
  }
  set(v: HiddenTracks) {
    this.value = v;
  }
}

function setup(store = new MemoryStore()) {
  const capture = new TrackNode({name: 'capture'});
  const tracks = ['D0', 'D1', 'D2'].map((name) => ({
    key: `logic:${name}`,
    label: name,
    node: new TrackNode({name}),
  }));
  for (const t of tracks) capture.addChildLast(t.node);
  let changes = 0;
  const vis = new CaptureTrackVisibility(store, 'a.sr', () => changes++);
  vis.addGroup(capture, tracks);
  const names = () => capture.children.map((c) => c.name);
  return {capture, tracks, vis, store, names, changes: () => changes};
}

test('hiding detaches tracks and showing restores the order', () => {
  const {vis, names, store} = setup();
  vis.hide('logic:D1');
  expect(names()).toEqual(['D0', 'D2']);
  expect(store.value).toEqual({'a.sr': ['logic:D1']});
  vis.hide('logic:D0');
  expect(names()).toEqual(['D2']);
  expect(vis.hiddenTracks.map((t) => t.label)).toEqual(['D0', 'D1']);
  vis.show('logic:D1');
  expect(names()).toEqual(['D1', 'D2']);
  vis.showAll();
  expect(names()).toEqual(['D0', 'D1', 'D2']);
  expect(store.value).toEqual({});
});

test('hidden tracks are restored from the store per capture file', () => {
  const store = new MemoryStore();
  store.value = {'a.sr': ['logic:D2'], 'other.sr': ['logic:D0']};
  const {vis, names, changes} = setup(store);
  vis.apply();
  expect(names()).toEqual(['D0', 'D1']);
  expect(changes()).toBe(1);
  vis.showAll();
  expect(store.value).toEqual({'other.sr': ['logic:D0']});
});

test('withHideButton adds a shell button and delegates everything else', () => {
  let hidden = 0;
  const inner = {
    height: 42,
    render() {},
    getHeight() {
      return this.height;
    },
  };
  const wrapped = withHideButton(inner, () => hidden++);
  expect(wrapped.getHeight?.()).toBe(42);
  expect(wrapped.onMouseMove).toBeUndefined();
  const buttons = wrapped.getTrackShellButtons?.() as unknown[];
  expect(buttons).toHaveLength(2);
  expect(hidden).toBe(0);
});
