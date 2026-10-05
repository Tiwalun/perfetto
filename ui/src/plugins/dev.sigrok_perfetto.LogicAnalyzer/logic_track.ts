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
import type {TimeScale} from '../../base/time_scale';
import {checkerboardExcept} from '../../components/checkerboard';
import {BufferedBounds} from '../../components/tracks/buffered_bounds';
import type {Trace} from '../../public/trace';
import type {
  SnapPoint,
  TrackMouseEvent,
  TrackRenderContext,
  TrackRenderer,
} from '../../public/track';
import {
  LONG,
  LONG_NULL,
  NUM,
  NUM_NULL,
} from '../../trace_processor/query_result';
import {
  createPerfettoTable,
  createVirtualTable,
} from '../../trace_processor/sql_utils';
import {formatDuration, formatFrequency} from './colors';

const TRACK_HEIGHT = 24;
const MARGIN = 5;

interface EdgeTables extends AsyncDisposable {
  // Table of (ts, value) rows, one per level change (plus the first sample).
  readonly edges: string;
  // __intrinsic_counter_mipmap over `edges`.
  readonly mipmap: string;
  // Timestamp of the last sample of the capture.
  readonly endTs: time;
}

interface Data {
  readonly start: time;
  readonly end: time;
  readonly resolution: duration;
  readonly endTs: time;
  readonly count: number;
  // Per mipmap bucket: timestamp of the last edge and levels.
  readonly ts: BigInt64Array;
  readonly busy: Uint8Array;
  readonly level: Uint8Array;
}

// Exact pulse measurements around the hovered timestamp.
interface Hover {
  readonly x: number;
  readonly ts: time;
  readonly level?: number;
  readonly pulseStart?: time;
  readonly pulseEnd?: time;
  readonly nextEnd?: time;
}

// Renders a logic channel stored as a 0/1 counter track like a logic
// analyzer does: a line toggling between a low and a high rail, with dense
// regions (more than one edge per pixel) drawn as filled blocks.
export class LogicTrack implements TrackRenderer {
  private readonly queue = new AtomicTaskQueue();
  private readonly tableMemo = new AsyncMemo<EdgeTables>(this.queue);
  private readonly dataMemo = new AsyncMemo<Data>(this.queue);
  private readonly bufferedBounds = new BufferedBounds();
  private tables?: EdgeTables;
  private data?: Data;
  private hover?: Hover;
  private hoverQuerySeq = 0;

  constructor(
    private readonly trace: Trace,
    private readonly trackId: number,
    private readonly color: string,
    private readonly onClick?: (track: LogicTrack) => void,
  ) {}

  getHeight(): number {
    return TRACK_HEIGHT;
  }

  private async createTables(): Promise<EdgeTables> {
    const trash = new AsyncDisposableStack();
    const edges = await createPerfettoTable({
      engine: this.trace.engine,
      as: `
        select ts, value
        from (
          select ts, value, lag(value) over (order by ts) as prev
          from counter
          where track_id = ${this.trackId}
        )
        where prev is null or prev != value
        order by ts
      `,
    });
    trash.use(edges);
    const mipmap = await createVirtualTable({
      engine: this.trace.engine,
      using: `__intrinsic_counter_mipmap((select ts, value from ${edges.name}))`,
    });
    trash.use(mipmap);
    const res = await this.trace.engine.query(
      `select max(ts) as endTs from counter where track_id = ${this.trackId}`,
    );
    const endTs = Time.fromRaw(res.firstRow({endTs: LONG}).endTs);
    return {
      edges: edges.name,
      mipmap: mipmap.name,
      endTs,
      [Symbol.asyncDispose]: () => trash.asyncDispose(),
    };
  }

  private async fetchData(
    tables: EdgeTables,
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
    const busy = new Uint8Array(count);
    const level = new Uint8Array(count);
    const it = res.iter({
      ts: LONG,
      minValue: NUM,
      maxValue: NUM,
      lastValue: NUM,
    });
    for (let i = 0; it.valid(); it.next(), i++) {
      ts[i] = it.ts;
      busy[i] = it.minValue !== it.maxValue ? 1 : 0;
      level[i] = it.lastValue > 0 ? 1 : 0;
    }
    return {
      start,
      end,
      resolution,
      endTs: tables.endTs,
      count,
      ts,
      busy,
      level,
    };
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
    if (data === undefined) return;

    const yHigh = MARGIN;
    const yLow = TRACK_HEIGHT - MARGIN;
    const toX = (t: bigint) =>
      Math.max(
        -2,
        Math.min(size.width + 2, timescale.timeToPx(Time.fromRaw(t))),
      );
    const endX = toX(data.endTs);
    const bucketPx = Math.max(1, timescale.durationToPx(data.resolution));

    // Light fill under high periods for readability.
    ctx.fillStyle = this.color;
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < data.count; i++) {
      if (data.level[i] === 0) continue;
      const x0 = toX(data.ts[i]);
      const x1 = i + 1 < data.count ? toX(data.ts[i + 1]) : endX;
      if (x1 > x0) ctx.fillRect(x0, yHigh, x1 - x0, yLow - yHigh);
    }
    // Dense regions.
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < data.count; i++) {
      if (data.busy[i] === 0) continue;
      const x = toX(data.ts[i]);
      ctx.fillRect(x - bucketPx, yHigh, bucketPx, yLow - yHigh);
    }
    ctx.globalAlpha = 1;

    // The waveform itself.
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let prevY = 0;
    for (let i = 0; i < data.count; i++) {
      const x = toX(data.ts[i]);
      const y = data.level[i] ? yHigh : yLow;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
      prevY = y;
    }
    if (data.count > 0) ctx.lineTo(endX, prevY);
    ctx.stroke();
    ctx.lineWidth = 1;

    if (this.hover?.pulseStart !== undefined) {
      const x0 = toX(this.hover.pulseStart);
      const x1 =
        this.hover.pulseEnd !== undefined ? toX(this.hover.pulseEnd) : endX;
      const y = this.hover.level === 1 ? yHigh : yLow;
      ctx.strokeStyle = colors.COLOR_TEXT;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }

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
    const ts = timescale.pxToHpTime(x).toTime();
    this.hover = {x, ts};
    this.queryHover(ts);
  }

  onMouseOut(): void {
    this.hover = undefined;
    this.hoverQuerySeq++;
    this.trace.raf.scheduleFullRedraw();
  }

  onMouseClick(): boolean {
    this.onClick?.(this);
    return false;
  }

  private async queryHover(ts: time) {
    const tables = this.tables;
    if (tables === undefined) return;
    const seq = ++this.hoverQuerySeq;
    const e = tables.edges;
    const res = await this.trace.engine.query(`
      select
        (select ts from ${e} where ts <= ${ts} order by ts desc limit 1) as e0,
        (select value from ${e} where ts <= ${ts} order by ts desc limit 1) as v0,
        (select ts from ${e} where ts > ${ts} order by ts limit 1) as e1,
        (select ts from ${e} where ts > ${ts} order by ts limit 1 offset 1) as e2
    `);
    if (seq !== this.hoverQuerySeq || this.hover === undefined) return;
    const row = res.firstRow({
      e0: LONG_NULL,
      v0: NUM_NULL,
      e1: LONG_NULL,
      e2: LONG_NULL,
    });
    if (row.e0 === null || ts > tables.endTs) {
      this.hover = {...this.hover, level: undefined, pulseStart: undefined};
    } else {
      this.hover = {
        ...this.hover,
        level: row.v0 ?? undefined,
        pulseStart: Time.fromRaw(row.e0),
        pulseEnd: row.e1 === null ? undefined : Time.fromRaw(row.e1),
        nextEnd: row.e2 === null ? undefined : Time.fromRaw(row.e2),
      };
    }
    this.trace.raf.scheduleFullRedraw();
  }

  renderTooltip(): m.Children {
    const h = this.hover;
    if (h?.level === undefined || h.pulseStart === undefined) return undefined;
    const lines: m.Children[] = [m('b', h.level === 1 ? 'HIGH' : 'LOW')];
    if (h.pulseEnd !== undefined) {
      const width = Number(h.pulseEnd - h.pulseStart);
      lines.push(m('div', `Pulse width: ${formatDuration(width)}`));
      if (h.nextEnd !== undefined) {
        const period = Number(h.nextEnd - h.pulseStart);
        const high = h.level === 1 ? width : Number(h.nextEnd - h.pulseEnd);
        lines.push(
          m(
            'div',
            `Period: ${formatDuration(period)} (${formatFrequency(1e9 / period)})`,
          ),
          m('div', `Duty cycle: ${((100 * high) / period).toFixed(1)} %`),
        );
      }
    } else {
      lines.push(m('div', 'Stays until end of capture'));
    }
    return m('', lines);
  }

  getSnapPoint(
    targetTime: time,
    thresholdPx: number,
    timescale: TimeScale,
  ): SnapPoint | undefined {
    const data = this.data;
    if (data === undefined) return undefined;
    const targetPx = timescale.timeToPx(targetTime);
    let best: SnapPoint | undefined;
    let bestDist = thresholdPx;
    for (let i = 1; i < data.count; i++) {
      if (data.level[i] === data.level[i - 1] && data.busy[i] === 0) continue;
      const t = Time.fromRaw(data.ts[i]);
      const dist = Math.abs(timescale.timeToPx(t) - targetPx);
      if (dist <= bestDist) {
        bestDist = dist;
        best = {time: t};
      }
    }
    return best;
  }

  // Returns the first edge strictly after (or before, if `backwards`) `ts`.
  async findEdge(ts: time, backwards: boolean): Promise<time | undefined> {
    const tables = this.tables;
    if (tables === undefined) return undefined;
    // Skip the first row, which is the initial level and not an edge.
    const res = await this.trace.engine.query(`
      select ts from ${tables.edges}
      where ts ${backwards ? '<' : '>'} ${ts}
        and ts > (select min(ts) from ${tables.edges})
      order by ts ${backwards ? 'desc' : 'asc'}
      limit 1
    `);
    const it = res.iter({ts: LONG});
    return it.valid() ? Time.fromRaw(it.ts) : undefined;
  }
}
