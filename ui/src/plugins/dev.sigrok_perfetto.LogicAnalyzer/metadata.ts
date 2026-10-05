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

// Track metadata written by sr2perfetto into each TrackDescriptor's
// `description` as `sigrok_perfetto:{json}`.

export const DESCRIPTION_PREFIX = 'sigrok_perfetto:';

export interface CaptureMeta {
  readonly kind: 'capture';
  readonly file: string;
  readonly samplerate: number;
  readonly samples: number;
  readonly t0_ns: number;
}

export interface LogicMeta {
  readonly kind: 'logic';
  readonly channel: string;
  readonly index: number;
  readonly derived: boolean;
  readonly samplerate: number;
}

export interface AnalogMeta {
  readonly kind: 'analog';
  readonly channel: string;
  readonly index: number;
  readonly samplerate: number;
  readonly samples: number;
}

export interface DecoderMeta {
  readonly kind: 'decoder';
  readonly decoder: string;
  readonly instance: string;
  readonly longname: string;
  readonly spec: string;
  readonly stack: number;
  readonly stack_position: number;
}

export interface AnnotationRowMeta {
  readonly kind: 'annotation_row';
  readonly decoder: string;
  readonly instance: string;
  readonly row: string;
  readonly row_index: number;
  readonly lane: number;
  readonly stack: number;
  readonly stack_position: number;
}

export type SigrokMeta =
  CaptureMeta | LogicMeta | AnalogMeta | DecoderMeta | AnnotationRowMeta;

const KINDS = new Set([
  'capture',
  'logic',
  'analog',
  'decoder',
  'annotation_row',
]);

// Returns the parsed metadata, or undefined if `description` was not written
// by sr2perfetto.
export function parseSigrokMeta(description: unknown): SigrokMeta | undefined {
  if (typeof description !== 'string') return undefined;
  if (!description.startsWith(DESCRIPTION_PREFIX)) return undefined;
  try {
    const meta = JSON.parse(description.slice(DESCRIPTION_PREFIX.length));
    if (typeof meta !== 'object' || meta === null) return undefined;
    if (!KINDS.has(meta.kind)) return undefined;
    return meta as SigrokMeta;
  } catch {
    return undefined;
  }
}

// Logic channel names referenced by a sigrok-cli decoder spec, e.g.
// `uart:rx=TX:baudrate=115200` -> ['TX'] if TX is a known channel. Only the
// first decoder of a stack has channel assignments.
export function specChannels(
  spec: string,
  channels: ReadonlyArray<string>,
): string[] {
  const first = spec.split(',')[0];
  const result: string[] = [];
  for (const opt of first.split(':').slice(1)) {
    const eq = opt.indexOf('=');
    if (eq < 0) continue;
    const value = opt.slice(eq + 1);
    if (channels.includes(value) && !result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}
