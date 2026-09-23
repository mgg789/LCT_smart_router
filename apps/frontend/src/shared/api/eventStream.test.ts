import { describe, expect, it } from 'vitest';
import { FrameBuffer, frameData } from './eventStream';

describe('frameData', () => {
  it('reads the payload of an ordinary frame', () => {
    expect(frameData('data: {"type":"message"}')).toBe('{"type":"message"}');
  });

  it('joins the several data lines of one frame into a single document', () => {
    expect(frameData('data: {"a":1,\ndata: "b":2}')).toBe('{"a":1,\n"b":2}');
  });

  it('keeps a payload that legitimately starts with a space beyond the first', () => {
    // Only one leading space belongs to the field separator; the rest is content.
    expect(frameData('data:  padded')).toBe(' padded');
  });

  it('reports a heartbeat as carrying nothing, rather than as an empty message', () => {
    expect(frameData(': ping')).toBeNull();
  });

  it('reports a frame with only an event name as carrying nothing', () => {
    expect(frameData('event: state\nid: 7')).toBeNull();
  });
});

describe('FrameBuffer', () => {
  it('yields each frame a chunk completes', () => {
    const buffer = new FrameBuffer();
    expect(buffer.push('data: 1\n\ndata: 2\n\n')).toEqual(['data: 1', 'data: 2']);
  });

  it('holds back a frame cut across the chunk boundary until its rest arrives', () => {
    const buffer = new FrameBuffer();
    expect(buffer.push('data: {"ty')).toEqual([]);
    expect(buffer.push('pe":"message"}\n\n')).toEqual(['data: {"type":"message"}']);
  });

  it('accepts both newline styles as a frame boundary', () => {
    const buffer = new FrameBuffer();
    expect(buffer.push('data: 1\r\n\r\ndata: 2\n\n')).toEqual(['data: 1', 'data: 2']);
  });

  it('does not treat a single newline inside a frame as its end', () => {
    const buffer = new FrameBuffer();
    expect(buffer.push('data: 1\ndata: 2\n\n')).toEqual(['data: 1\ndata: 2']);
  });

  it('returns an unterminated tail once, when the stream is closed', () => {
    const buffer = new FrameBuffer();
    buffer.push('data: 1');
    expect(buffer.flush()).toEqual(['data: 1']);
    expect(buffer.flush()).toEqual([]);
  });

  it('flushes nothing when the stream ended on a frame boundary', () => {
    const buffer = new FrameBuffer();
    buffer.push('data: 1\n\n');
    expect(buffer.flush()).toEqual([]);
  });
});
