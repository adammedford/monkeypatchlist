// One request and its response, over a connection the floor has opened (§17 Safety floor: Requests, Size).

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { Writable, type Duplex, type Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { FetchedResponse } from '../index.ts'
import { Failure, reason, Refusal } from './outcomes.ts'
import type { SessionOptions } from './session.ts'

/**
 * What one request got: the response's status and recorded headers, its `Location` and `X-Content-Type-Options`, and a
 * 2xx response's body.
 */
export interface Answer {
  response: FetchedResponse
  status: number
  location: string | null
  nosniff: string | null
  bytes: Uint8Array | null
}

/** How many bytes a response's body may hold, decompressed (§17 Size). */
export interface ByteLimits {
  /** The most one response may have. */
  responseBytes: number
  /** The most all the responses of the scan may have. */
  scanBytes: number
  /** The bytes the scan's earlier responses had. */
  scanned: number
}

/**
 * Sends a `GET` for `url` over `connection`: with monkeypatchlist's `User-Agent`, and without cookies, credentials or
 * conditional headers (§17 Requests). Only a 2xx response's body is read, decompressed from `gzip` or `br`, and it is
 * refused as soon as it holds more bytes than `limits` allow.
 */
export function exchange(
  url: URL,
  connection: Duplex,
  { version }: Pick<SessionOptions, 'version'>,
  limits: ByteLimits,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      createConnection: () => connection,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      setHost: false,
      headers: {
        Host: url.host,
        'User-Agent': `monkeypatchlist/${version}`,
        Accept: '*/*',
        'Accept-Encoding': 'gzip, br',
        Connection: 'close',
      },
    })
    request.on('error', (error) => reject(new Failure(`the request for ${url.href} failed: ${reason(error)}`)))
    request.once('response', (message: IncomingMessage) => {
      const status = message.statusCode ?? 0
      const response = recorded(url, message)
      const location = header(message, 'location')
      const nosniff = header(message, 'x-content-type-options')
      if (status < 200 || status > 299) {
        message.destroy()
        connection.destroy()
        resolve({ response, status, location, nosniff, bytes: null })
        return
      }
      body(url, message, response, limits)
        .then((bytes) => resolve({ response, status, location, nosniff, bytes }), reject)
        .finally(() => connection.destroy())
    })
    request.end()
  })
}

/** Reads a response's body, decoded, refusing it once it holds more bytes than `limits` allow. */
async function body(
  url: URL,
  message: IncomingMessage,
  response: FetchedResponse,
  { responseBytes, scanBytes, scanned }: ByteLimits,
): Promise<Uint8Array> {
  const decoders = decodersFor(header(message, 'content-encoding'))
  const chunks: Buffer[] = []
  let size = 0
  const sink = new Writable({
    write(chunk: Buffer, _, callback) {
      size += chunk.length
      if (size > responseBytes) {
        callback(new Refusal(`the safety floor refuses a response of more than ${responseBytes} bytes`, response))
      } else if (scanned + size > scanBytes) {
        callback(new Refusal(`the safety floor refuses more than ${scanBytes} bytes of responses in a scan`, response))
      } else {
        chunks.push(chunk)
        callback()
      }
    },
  })
  try {
    await pipeline([message, ...decoders, sink])
  } catch (error) {
    if (error instanceof Refusal || error instanceof Failure) throw error
    throw new Failure(`reading ${url.href} failed: ${reason(error)}`)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * The decoders a `Content-Encoding` needs, in the order to apply them: the codings are listed in the order they were
 * applied. A coding the floor can't decode fails the fetch.
 */
function decodersFor(encoding: string | null): Transform[] {
  const codings = (encoding ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity')
  return codings.reverse().map((coding) => {
    switch (coding) {
      case 'gzip':
      case 'x-gzip':
        return createGunzip()
      case 'br':
        return createBrotliDecompress()
      case 'deflate':
        return createInflate()
      default:
        throw new Failure(`the response has a content coding monkeypatchlist can't decode: ${coding}`)
    }
  })
}

/** The response's URL and the headers that are recorded (§17 What is recorded). */
function recorded(url: URL, message: IncomingMessage): FetchedResponse {
  return {
    finalUrl: url.href,
    contentType: header(message, 'content-type'),
    etag: header(message, 'etag'),
    lastModified: header(message, 'last-modified'),
    sourceMap: header(message, 'sourcemap') ?? header(message, 'x-sourcemap'),
  }
}

function header(message: IncomingMessage, name: string): string | null {
  const value = message.headers[name]
  return typeof value === 'string' ? value : null
}
