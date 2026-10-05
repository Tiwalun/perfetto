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
import {ThreadSliceDetailsPanel} from '../../components/details/thread_slice_details_tab';
import {SliceTrack, renderTooltip} from '../../components/tracks/slice_track';
import type {Trace} from '../../public/trace';
import {SourceDataset} from '../../trace_processor/dataset';
import {
  LONG,
  NUM,
  NUM_NULL,
  STR_NULL,
} from '../../trace_processor/query_result';
import {annotationColorScheme} from './colors';

const schema = {
  id: NUM,
  ts: LONG,
  dur: LONG,
  depth: NUM,
  name: STR_NULL,
  class_index: NUM_NULL,
  class_desc: STR_NULL,
  arg_set_id: NUM_NULL,
};

export interface AnnotationTrackArgs {
  readonly trace: Trace;
  readonly uri: string;
  readonly trackId: number;
  // Global index of the decoder instance (for the colour scheme).
  readonly decoderIndex: number;
  readonly rowIndex: number;
}

// Decoder annotation row: one slice per sigrok annotation, coloured per
// annotation class like PulseView does.
export function createAnnotationTrack(args: AnnotationTrackArgs) {
  const {trace, uri, trackId, decoderIndex, rowIndex} = args;
  return SliceTrack.create({
    trace,
    uri,
    rootTableName: 'slice',
    dataset: new SourceDataset({
      schema,
      select: {
        id: 'id',
        ts: 'ts',
        dur: 'dur',
        depth: 'depth',
        name: 'name',
        class_index: "extract_arg(arg_set_id, 'debug.class_index')",
        class_desc: "extract_arg(arg_set_id, 'debug.class_desc')",
        arg_set_id: 'arg_set_id',
      },
      src: 'slice',
      filter: {col: 'track_id', eq: trackId},
    }),
    sliceLayout: {padding: 3, sliceHeight: 16, titleSizePx: 11},
    sliceName: (row) => row.name ?? '',
    colorizer: (row) =>
      annotationColorScheme(decoderIndex, rowIndex, row.class_index ?? 0),
    tooltip: (slice) =>
      renderTooltip(trace, slice, {
        title: slice.title,
        extras: slice.row.class_desc !== null && m('', slice.row.class_desc),
      }),
    detailsPanel: () => new ThreadSliceDetailsPanel(trace),
  });
}
