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

import {HSLColor} from '../../base/color';
import type {ColorScheme} from '../../base/color_scheme';
import {makeColorScheme} from '../../components/colorizer';

// PulseView's logic channel palette (resistor colour code).
const LOGIC_PALETTE = [
  '#16191A', // 0 black
  '#8F5202', // 1 brown
  '#CC0000', // 2 red
  '#F57900', // 3 orange
  '#EDD400', // 4 yellow
  '#73D216', // 5 green
  '#3465A4', // 6 blue
  '#75507B', // 7 violet
  '#888A85', // 8 grey
  '#EEEEEC', // 9 white
];

// PulseView's analog channel palette.
const ANALOG_PALETTE = [
  '#C4A000',
  '#87207A',
  '#204A87',
  '#4E9A06',
  '#BF6E00',
  '#5E2080',
  '#20807A',
  '#802024',
];

// Black and white are invisible on one of the two themes, so the logic
// palette skips them and starts at brown like most logic analyzer probes
// labelled 1..8 do after the black ground lead.
export function logicChannelColor(position: number): string {
  const usable = LOGIC_PALETTE.slice(1, 9);
  return usable[((position % usable.length) + usable.length) % usable.length];
}

export function analogChannelColor(position: number): string {
  const n = ANALOG_PALETTE.length;
  return ANALOG_PALETTE[((position % n) + n) % n];
}

// Hue of an annotation, following PulseView: every decoder gets a base hue,
// rows are offset by 20 degrees and classes by 55 degrees.
export function annotationHue(
  decoderIndex: number,
  rowIndex: number,
  classIndex: number,
): number {
  const base = 120 + 160 * decoderIndex;
  const row = base + 20 * rowIndex;
  return (((row + 55 * classIndex) % 360) + 360) % 360;
}

const schemeCache = new Map<number, ColorScheme>();

export function annotationColorScheme(
  decoderIndex: number,
  rowIndex: number,
  classIndex: number,
): ColorScheme {
  const hue = annotationHue(decoderIndex, rowIndex, classIndex);
  let scheme = schemeCache.get(hue);
  if (scheme === undefined) {
    scheme = makeColorScheme(new HSLColor([hue, 70, 67]));
    schemeCache.set(hue, scheme);
  }
  return scheme;
}

// Formats a duration in nanoseconds with a sensible unit.
export function formatDuration(ns: number): string {
  const abs = Math.abs(ns);
  if (abs >= 1e9) return `${(ns / 1e9).toPrecision(4)} s`;
  if (abs >= 1e6) return `${(ns / 1e6).toPrecision(4)} ms`;
  if (abs >= 1e3) return `${(ns / 1e3).toPrecision(4)} µs`;
  return `${ns.toFixed(0)} ns`;
}

export function formatFrequency(hz: number): string {
  if (hz >= 1e9) return `${(hz / 1e9).toPrecision(4)} GHz`;
  if (hz >= 1e6) return `${(hz / 1e6).toPrecision(4)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toPrecision(4)} kHz`;
  return `${hz.toPrecision(4)} Hz`;
}

export function formatVolts(v: number): string {
  if (v !== 0 && Math.abs(v) < 0.1) return `${(v * 1e3).toPrecision(3)} mV`;
  return `${v.toPrecision(3)} V`;
}
