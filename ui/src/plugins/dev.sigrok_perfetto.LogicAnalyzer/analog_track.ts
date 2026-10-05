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
import {
  AsyncMemo,
  AtomicTaskQueue,
  type CancellationSignal,
  TASK_CANCELLED,
} from '../../base/async_memo';
import {AsyncDisposableStack} from '../../base/disposable_stack';
import {type duration, type time, Time} from '../../base/time';
import {checkerboardExcept} from '../../components/checkerboard';
import {BufferedBounds} from '../../components/tracks/buffered_bounds';
import type {Trace} from '../../public/trace';
import type {
  TrackMouseEvent,
  TrackRenderContext,
  TrackRenderer,
} from '../../public/track';
import {LONG, NUM} from '../../trace_processor/query_result';
import {createVirtualTable} from '../../trace_processor/sql_utils';
import {formatVolts} from './colors';

const TRACK_HEIGHT = 64;
const MARGIN = 6;

interface Tables extends AsyncDisposable {
  readonly mipmap: string;
  readonly minValue: number;
  readonly maxValue: number;
  readonly endTs: time;
}

interface Data {
  readonly start: time;
  readonly end: time;
  readonly resolution: duration;
  readonly count: number;
  readonly ts: BigInt64Array;
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly last: Float64Array;
}

// Renders an analog channel as an oscilloscope-like trace: the per-pixel
// min/max envelope plus a line through the sample values.
export class AnalogTrack implements TrackRenderer {
  private readonly queue = new AtomicTaskQueue();
  private readonly tableMemo = new AsyncMemo<Tables>(this.queue);
  private readonly dataMemo = new AsyncMemo<Data>(this.queue);
  private readonly bufferedBounds = new BufferedBounds();
  private tables?: Tables;
  private data?: Data;
  private hover?: {ts: time; value: number; x: number};

  constructor(
    private readonly trace: Trace,
    private readonly trackId: number,
    private readonly color: string,
  ) {}

  getHeight(): number {
    return TRACK_HEIGHT;
  }

  private async createTables(): Promise<Tables> {
    const trash = new AsyncDisposableStack();
    const mipmap = await createVirtualTable({
      engine: this.trace.engine,
      using: `__intrinsic_counter_mipmap((
        select ts, value from counter where track_id = ${this.trackId}
      ))`,
    });
    trash.use(mipmap);
    const res = await this.trace.engine.query(`
      select
        ifnull(min(value), 0) as minValue,
        ifnull(max(value), 0) as maxValue,
        ifnull(max(ts), 0) as endTs
      from counter where track_id = ${this.trackId}
    `);
    const row = res.firstRow({minValue: NUM, maxValue: NUM, endTs: LONG});
    return {
      mipmap: mipmap.name,
      minValue: row.minValue,
      maxValue: row.maxValue,
      endTs: Time.fromRaw(row.endTs),
      [Symbol.asyncDispose]: () => trash.asyncDispose(),
    };
  }

  private async fetchData(
    tables: Tables,
    start: time,
    end: time,
    resolution: duration,
    signal: CancellationSignal,
  ): Promise<Data | typeof TASK_CANCELLED> {
    const res = await this.trace.engine.query(`
      select
        last_ts as ts,
        min_value as minValue,
        max_value as maxValue,
        last_value as lastValue
      from ${tables.mipmap}(${start}, ${end}, ${resolution})
    `);
    if (signal.isCancelled) return TASK_CANCELLED;
    const count = res.numRows();
    const ts = new BigInt64Array(count);
    const min = new Float64Array(count);
    const max = new Float64Array(count);
    const last = new Float64Array(count);
    const it = res.iter({
      ts: LONG,
      minValue: NUM,
      maxValue: NUM,
      lastValue: NUM,
    });
    for (let i = 0; it.valid(); it.next(), i++) {
      ts[i] = it.ts;
      min[i] = it.minValue;
      max[i] = it.maxValue;
      last[i] = it.lastValue;
    }
    return {start, end, resolution, count, ts, min, max, last};
  }

  render({
    ctx,
    size,
    timescale,
    visibleWindow,
    resolution,
    colors,
  }: TrackRenderContext): void {
    const tableResult = this.tableMemo.use({
      key: {trackId: this.trackId},
      compute: () => this.createTables(),
    });
    this.tables = tableResult.data;
    const bounds = this.bufferedBounds.update(
      visibleWindow.toTimeSpan(),
      resolution,
    );
    const dataResult = this.dataMemo.use({
      key: {
        start: bounds.start,
        end: bounds.end,
        resolution: bounds.resolution,
      },
      compute: async (signal) => {
        const result = await this.fetchData(
          this.tables!,
          bounds.start,
          bounds.end,
          bounds.resolution,
          signal,
        );
        this.trace.raf.scheduleCanvasRedraw();
        return result;
      },
      retainOn: ['start', 'end', 'resolution'],
      enabled: this.tables !== undefined,
    });
    this.data = dataResult.data;
    const data = this.data;
    const tables = this.tables;
    if (data === undefined || tables === undefined) return;

    let lo = tables.minValue;
    let hi = tables.maxValue;
    if (hi - lo < 1e-9) {
      lo -= 0.5;
      hi += 0.5;
    }
    const pad = (hi - lo) * 0.05;
    lo -= pad;
    hi += pad;
    const toY = (v: number) =>
      MARGIN + ((hi - v) / (hi - lo)) * (TRACK_HEIGHT - 2 * MARGIN);
    const toX = (t: bigint) =>
      Math.max(
        -2,
        Math.min(size.width + 2, timescale.timeToPx(Time.fromRaw(t))),
      );
    const bucketPx = Math.max(1, timescale.durationToPx(data.resolution));

    // Zero line, if visible.
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = colors.COLOR_BORDER;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, toY(0));
      ctx.lineTo(size.width, toY(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Envelope of buckets that contain more than one sample.
    ctx.fillStyle = this.color;
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < data.count; i++) {
      if (data.max[i] === data.min[i]) continue;
      const x = toX(data.ts[i]);
      const y0 = toY(data.max[i]);
      ctx.fillRect(
        x - bucketPx,
        y0,
        bucketPx,
        Math.max(1, toY(data.min[i]) - y0),
      );
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < data.count; i++) {
      const x = toX(data.ts[i]);
      const y = toY(data.last[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;

    if (this.hover !== undefined) {
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.hover.x, toY(this.hover.value), 3, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Y axis labels.
    ctx.font = '10px Roboto Condensed';
    ctx.textAlign = 'left';
    ctx.fillStyle = colors.COLOR_TEXT;
    ctx.globalAlpha = 0.8;
    ctx.textBaseline = 'top';
    ctx.fillText(formatVolts(tables.maxValue), 4, 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatVolts(tables.minValue), 4, TRACK_HEIGHT - 2);
    ctx.globalAlpha = 1;

    checkerboardExcept(
      ctx,
      this.getHeight(),
      0,
      size.width,
      timescale.timeToPx(data.start),
      timescale.timeToPx(data.end),
    );
  }

  onMouseMove({x, timescale}: TrackMouseEvent): void {
    const data = this.data;
    if (data === undefined || this.tables === undefined) return;
    const ts = timescale.pxToHpTime(x).toTime();
    if (ts > this.tables.endTs) {
      this.hover = undefined;
      return;
    }
    // Last bucket at or before the cursor.
    let lo = 0;
    let hi = data.count - 1;
    if (hi < 0 || data.ts[0] > ts) {
      this.hover = undefined;
      return;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (data.ts[mid] <= ts) lo = mid;
      else hi = mid - 1;
    }
    this.hover = {ts, value: data.last[lo], x};
    this.trace.raf.scheduleFullRedraw();
  }

  onMouseOut(): void {
    this.hover = undefined;
    this.trace.raf.scheduleFullRedraw();
  }

  renderTooltip(): m.Children {
    if (this.hover === undefined) return undefined;
    return m('b', formatVolts(this.hover.value));
  }
}
