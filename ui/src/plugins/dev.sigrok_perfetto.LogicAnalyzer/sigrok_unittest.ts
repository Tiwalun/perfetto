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

import {
  annotationHue,
  formatDuration,
  formatFrequency,
  formatVolts,
  logicChannelColor,
} from './colors';
import {parseSigrokMeta, specChannels} from './metadata';

test('parses sr2perfetto descriptions', () => {
  const meta = parseSigrokMeta(
    'sigrok_perfetto:{"kind":"logic","channel":"TX","index":0,' +
      '"derived":false,"samplerate":1000000}',
  );
  expect(meta).toEqual({
    kind: 'logic',
    channel: 'TX',
    index: 0,
    derived: false,
    samplerate: 1000000,
  });
});

test('ignores foreign or malformed descriptions', () => {
  expect(parseSigrokMeta(undefined)).toBeUndefined();
  expect(parseSigrokMeta('Some other track')).toBeUndefined();
  expect(parseSigrokMeta('sigrok_perfetto:{not json')).toBeUndefined();
  expect(parseSigrokMeta('sigrok_perfetto:{"kind":"other"}')).toBeUndefined();
  expect(parseSigrokMeta('sigrok_perfetto:null')).toBeUndefined();
});

test('finds the channels a decoder spec uses', () => {
  const channels = ['SCL', 'SDA', 'TRIG', '0', '1'];
  expect(
    specChannels('i2c:scl=SCL:sda=SDA,eeprom24xx:chip=x', channels),
  ).toEqual(['SCL', 'SDA']);
  expect(specChannels('spi:clk=0:mosi=1:cs=1', channels)).toEqual(['0', '1']);
  expect(specChannels('uart:baudrate=9600', channels)).toEqual([]);
  // Only the first decoder of a stack has channel options.
  expect(specChannels('i2c,eeprom24xx:x=TRIG', channels)).toEqual([]);
});

test('annotation hues follow the PulseView scheme', () => {
  expect(annotationHue(0, 0, 0)).toBe(120);
  expect(annotationHue(1, 0, 0)).toBe(280);
  expect(annotationHue(0, 1, 0)).toBe(140);
  expect(annotationHue(0, 0, 1)).toBe(175);
  expect(annotationHue(2, 3, 4)).toBe((120 + 320 + 60 + 220) % 360);
});

test('logic colours cycle and skip black/white', () => {
  expect(logicChannelColor(0)).toBe('#8F5202');
  expect(logicChannelColor(8)).toBe(logicChannelColor(0));
  expect(logicChannelColor(-1)).toBe(logicChannelColor(7));
});

test('formats units', () => {
  expect(formatDuration(8680)).toBe('8.680 µs');
  expect(formatDuration(500)).toBe('500 ns');
  expect(formatDuration(2.5e9)).toBe('2.500 s');
  expect(formatFrequency(115200)).toBe('115.2 kHz');
  expect(formatFrequency(12e6)).toBe('12.00 MHz');
  expect(formatVolts(3.3)).toBe('3.30 V');
  expect(formatVolts(0.05)).toBe('50.0 mV');
  expect(formatVolts(0)).toBe('0.00 V');
});
