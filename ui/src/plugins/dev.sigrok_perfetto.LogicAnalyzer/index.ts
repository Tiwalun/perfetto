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

import {type time, Time} from '../../base/time';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import type {Track} from '../../public/track';
import {COUNTER_TRACK_KIND, SLICE_TRACK_KIND} from '../../public/track_kinds';
import type {TrackNode} from '../../public/workspace';
import TrackEventPlugin from '../dev.perfetto.TrackEvent';
import {AnalogTrack} from './analog_track';
import {createAnnotationTrack} from './annotation_track';
import {
  analogChannelColor,
  formatDuration,
  formatFrequency,
  logicChannelColor,
} from './colors';
import {LogicTrack} from './logic_track';
import {
  type CaptureMeta,
  type DecoderMeta,
  parseSigrokMeta,
  type SigrokMeta,
  specChannels,
} from './metadata';

interface SigrokTrack {
  readonly track: Track;
  readonly trackId: number;
  readonly meta: SigrokMeta;
  readonly node: TrackNode;
}

// Shows logic analyzer captures converted by sr2perfetto (see the
// perfetto_sigrok repository) like a logic analyzer UI: digital waveforms,
// analog traces and protocol decoder annotation rows grouped per capture.
//
// sr2perfetto writes ordinary TrackEvent counter/slice tracks whose
// descriptions carry `sigrok_perfetto:{json}` metadata. The TrackEvent plugin
// creates the workspace nodes for them; this plugin then swaps in custom
// renderers and rearranges the nodes.
export default class SigrokLogicAnalyzerPlugin implements PerfettoPlugin {
  static readonly id = 'dev.sigrok_perfetto.LogicAnalyzer';
  static readonly description =
    'Logic analyzer view for sigrok captures converted with sr2perfetto';
  static readonly dependencies = [TrackEventPlugin];

  private readonly logicTracks: LogicTrack[] = [];
  private activeLogic?: LogicTrack;
  private lastJump?: time;

  async onTraceLoad(trace: Trace): Promise<void> {
    const tracks = this.findSigrokTracks(trace);
    if (tracks.length === 0) return;

    const decoderIndex = this.assignDecoderIndices(tracks);
    const captures = tracks.filter((t) => t.meta.kind === 'capture');

    for (const capture of captures) {
      const children = tracks.filter((t) => isDescendant(t.node, capture.node));
      this.setUpCapture(trace, capture, children, decoderIndex);
    }

    this.registerCommands(trace, tracks);
  }

  private findSigrokTracks(trace: Trace): SigrokTrack[] {
    const result: SigrokTrack[] = [];
    for (const track of trace.tracks.getAllTracks()) {
      const meta = parseSigrokMeta(track.description);
      if (meta === undefined) continue;
      const trackId = track.tags?.trackIds?.[0];
      if (trackId === undefined) continue;
      const node = trace.defaultWorkspace.getTrackByUri(track.uri);
      if (node === undefined) continue;
      result.push({track, trackId, meta, node});
    }
    return result;
  }

  // Assigns every decoder instance a stable index used for colours, ordered
  // by (stack, position in stack) like PulseView orders its decode traces.
  private assignDecoderIndices(tracks: SigrokTrack[]): Map<string, number> {
    const decoders = tracks
      .map((t) => t.meta)
      .filter((m): m is DecoderMeta => m.kind === 'decoder')
      .sort((a, b) => a.stack - b.stack || a.stack_position - b.stack_position);
    const result = new Map<string, number>();
    for (const d of decoders) {
      const key = `${d.stack}/${d.instance}`;
      if (!result.has(key)) result.set(key, result.size);
    }
    return result;
  }

  private setUpCapture(
    trace: Trace,
    capture: SigrokTrack,
    tracks: SigrokTrack[],
    decoderIndex: Map<string, number>,
  ) {
    const meta = capture.meta as CaptureMeta;
    const logic = tracks
      .filter((t) => t.meta.kind === 'logic')
      .sort((a, b) => metaIndex(a) - metaIndex(b));
    const analog = tracks
      .filter((t) => t.meta.kind === 'analog')
      .sort((a, b) => metaIndex(a) - metaIndex(b));

    logic.forEach((t, position) => {
      if (t.meta.kind !== 'logic') return;
      const uri = `/sigrok/logic/${t.trackId}`;
      const renderer = new LogicTrack(
        trace,
        t.trackId,
        logicChannelColor(position),
        (track) => (this.activeLogic = track),
      );
      this.logicTracks.push(renderer);
      trace.tracks.registerTrack({
        uri,
        renderer,
        description: `Logic channel ${t.meta.channel}${
          t.meta.derived ? ' (derived from analog by threshold)' : ''
        }`,
        tags: {kinds: [COUNTER_TRACK_KIND], trackIds: [t.trackId]},
      });
      t.node.uri = uri;
    });

    analog.forEach((t, position) => {
      if (t.meta.kind !== 'analog') return;
      const uri = `/sigrok/analog/${t.trackId}`;
      trace.tracks.registerTrack({
        uri,
        renderer: new AnalogTrack(
          trace,
          t.trackId,
          analogChannelColor(position),
        ),
        description: `Analog channel ${t.meta.channel}`,
        tags: {kinds: [COUNTER_TRACK_KIND], trackIds: [t.trackId]},
      });
      t.node.uri = uri;
    });

    for (const t of tracks) {
      const m = t.meta;
      if (m.kind === 'annotation_row') {
        const uri = `/sigrok/annotations/${t.trackId}`;
        trace.tracks.registerTrack({
          uri,
          renderer: createAnnotationTrack({
            trace,
            uri,
            trackId: t.trackId,
            decoderIndex: decoderIndex.get(`${m.stack}/${m.instance}`) ?? 0,
            rowIndex: m.row_index,
          }),
          description: `${m.instance}: annotation row ${m.row}`,
          tags: {kinds: [SLICE_TRACK_KIND], trackIds: [t.trackId]},
        });
        t.node.uri = uri;
      } else if (m.kind === 'decoder') {
        t.node.subtitle = m.longname;
        t.node.expand();
      }
    }

    // Order: each logic channel, followed by the decoders that use it (after
    // their last input channel); then remaining decoders; then analog.
    const channelNames = logic.map(
      (t) => (t.meta as {channel: string}).channel,
    );
    const decoders = tracks.filter(
      (t) => t.meta.kind === 'decoder' && t.node.parent === capture.node,
    );
    const decodersAfter = new Map<number, SigrokTrack[]>();
    const unplaced: SigrokTrack[] = [];
    for (const d of decoders) {
      const spec = (d.meta as DecoderMeta).spec;
      const positions = specChannels(spec, channelNames).map((c) =>
        channelNames.indexOf(c),
      );
      // Stacked decoders (position > 0) follow their parent decoder.
      if (
        positions.length === 0 ||
        (d.meta as DecoderMeta).stack_position > 0
      ) {
        unplaced.push(d);
        continue;
      }
      const after = Math.max(...positions);
      decodersAfter.set(after, [...(decodersAfter.get(after) ?? []), d]);
    }
    const ordered: TrackNode[] = [];
    const placeStack = (d: SigrokTrack) => {
      ordered.push(d.node);
      const dm = d.meta as DecoderMeta;
      // Followed by decoders stacked on top of it.
      for (const u of unplaced) {
        const um = u.meta as DecoderMeta;
        if (um.stack === dm.stack && um.stack_position > 0) {
          ordered.push(u.node);
        }
      }
    };
    logic.forEach((t, i) => {
      ordered.push(t.node);
      for (const d of decodersAfter.get(i) ?? []) placeStack(d);
    });
    for (const u of unplaced) {
      if (!ordered.includes(u.node)) ordered.push(u.node);
    }
    for (const a of analog) ordered.push(a.node);
    for (const child of capture.node.children) {
      if (!ordered.includes(child)) ordered.push(child);
    }
    for (const node of ordered) capture.node.removeChild(node);
    for (const node of ordered) capture.node.addChildLast(node);

    // Put the capture at the top of the workspace, expanded.
    const durationNs = (meta.samples / meta.samplerate) * 1e9;
    capture.node.name = meta.file;
    capture.node.subtitle = `sigrok · ${formatFrequency(meta.samplerate)} · ${formatDuration(durationNs)}`;
    capture.node.remove();
    trace.defaultWorkspace.addChildFirst(capture.node);
    capture.node.expand();
  }

  private registerCommands(trace: Trace, tracks: SigrokTrack[]) {
    const id = SigrokLogicAnalyzerPlugin.id;
    const jump = async (backwards: boolean) => {
      const track = this.activeLogic ?? this.logicTracks[0];
      if (track === undefined) return;
      const window = trace.timeline.visibleWindow;
      let from = window.start.addNumber(window.duration / 2).toTime();
      // Continue from the previous jump target if the view still shows it
      // centred, so rounding cannot make us find the same edge again.
      if (this.lastJump !== undefined) {
        const pxNs = window.duration / 1000;
        if (Math.abs(Number(from - this.lastJump)) < pxNs) from = this.lastJump;
      }
      const edge = await track.findEdge(from, backwards);
      if (edge === undefined) return;
      this.lastJump = edge;
      trace.timeline.panIntoView(Time.fromRaw(edge), {align: 'center'});
    };
    trace.commands.registerCommand({
      id: `${id}#NextEdge`,
      name: 'sigrok: Jump to next edge (last clicked logic channel)',
      callback: () => jump(false),
    });
    trace.commands.registerCommand({
      id: `${id}#PrevEdge`,
      name: 'sigrok: Jump to previous edge (last clicked logic channel)',
      callback: () => jump(true),
    });
    const decoderNodes = tracks
      .filter((t) => t.meta.kind === 'decoder')
      .map((t) => t.node);
    trace.commands.registerCommand({
      id: `${id}#ExpandDecoders`,
      name: 'sigrok: Expand all decoders',
      callback: () => decoderNodes.forEach((n) => n.expand()),
    });
    trace.commands.registerCommand({
      id: `${id}#CollapseDecoders`,
      name: 'sigrok: Collapse all decoders',
      callback: () => decoderNodes.forEach((n) => n.collapse()),
    });
  }
}

function metaIndex(t: SigrokTrack): number {
  return 'index' in t.meta ? t.meta.index : 0;
}

function isDescendant(node: TrackNode, ancestor: TrackNode): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (p === ancestor) return true;
  }
  return false;
}
