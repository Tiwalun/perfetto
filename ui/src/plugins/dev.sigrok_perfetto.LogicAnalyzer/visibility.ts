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

import m from 'mithril';
import {Icons} from '../../base/semantic_icons';
import type {TrackRenderer} from '../../public/track';
import type {TrackNode} from '../../public/workspace';
import {Button} from '../../widgets/button';

// Hidden track keys per capture file name (as stored in the setting).
export type HiddenTracks = Record<string, string[]>;

// Minimal view of the persisted setting holding HiddenTracks.
export interface HiddenTracksStore {
  get(): HiddenTracks;
  set(value: HiddenTracks): void;
}

export interface ToggleableTrack {
  // Stable identifier within the capture, e.g. `logic:D3`.
  readonly key: string;
  // Human readable name used in the "show hidden track" picker.
  readonly label: string;
  readonly node: TrackNode;
}

interface Group {
  readonly parent: TrackNode;
  readonly children: ReadonlyArray<ToggleableTrack>;
}

// Hides and shows the tracks of one capture. The workspace has no notion of
// hidden tracks, so hiding detaches a node and showing re-inserts it at its
// original position. Hidden keys are persisted per capture file, so a track
// stays hidden when the capture is opened again.
export class CaptureTrackVisibility {
  private readonly groups: Group[] = [];

  constructor(
    private readonly store: HiddenTracksStore,
    readonly captureName: string,
    // Called after every change, e.g. to update a "N hidden" subtitle.
    private readonly onChange: () => void = () => {},
  ) {}

  // Registers `parent` with its children in display order.
  addGroup(parent: TrackNode, children: ReadonlyArray<ToggleableTrack>) {
    this.groups.push({parent, children});
  }

  get hiddenKeys(): ReadonlyArray<string> {
    return this.store.get()[this.captureName] ?? [];
  }

  // Hidden tracks of this capture, for the "show" picker.
  get hiddenTracks(): ReadonlyArray<ToggleableTrack> {
    const hidden = new Set(this.hiddenKeys);
    return this.allTracks.filter((t) => hidden.has(t.key));
  }

  get allTracks(): ReadonlyArray<ToggleableTrack> {
    return this.groups.flatMap((g) => g.children);
  }

  hide(...keys: string[]) {
    this.setHidden([...new Set([...this.hiddenKeys, ...keys])]);
  }

  show(...keys: string[]) {
    this.setHidden(this.hiddenKeys.filter((k) => !keys.includes(k)));
  }

  showAll() {
    this.setHidden([]);
  }

  private setHidden(keys: ReadonlyArray<string>) {
    const all = {...this.store.get()};
    if (keys.length === 0) {
      delete all[this.captureName];
    } else {
      all[this.captureName] = [...keys];
    }
    this.store.set(all);
    this.apply();
  }

  // Rebuilds the children of every group from the hidden set.
  apply() {
    const hidden = new Set(this.hiddenKeys);
    for (const {parent, children} of this.groups) {
      for (const c of children) {
        if (c.node.parent === parent) parent.removeChild(c.node);
      }
      for (const c of children) {
        if (!hidden.has(c.key)) {
          parent.addChildLast(c.node);
        } else if (c.node.isPinned) {
          c.node.unpin();
        }
      }
    }
    this.onChange();
  }
}

// Returns `renderer` with an extra "hide" button in the track shell. A proxy
// keeps every other member (and its presence) exactly as in `renderer`.
export function withHideButton(
  renderer: TrackRenderer,
  onHide: () => void,
): TrackRenderer {
  const button = () =>
    m(Button, {
      icon: Icons.Hide,
      title: 'Hide track (restore with "sigrok: Show hidden track")',
      compact: true,
      className: 'pf-visible-on-hover',
      onclick: onHide,
    });
  return new Proxy(renderer, {
    get(target, prop) {
      if (prop === 'getTrackShellButtons') {
        return () => [target.getTrackShellButtons?.(), button()];
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
