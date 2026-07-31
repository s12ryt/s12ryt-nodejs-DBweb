import { describe, expect, it } from 'vitest'

import type { TransferDataRow } from './transfer-data-gateway.js'
import {
  FriendlyCsvError,
  encodeFriendlyCsv,
} from './friendly-csv-format.js'

async function collect(chunks: AsyncIterable<Buffer>): Promise<string> {
  const buffers: Buffer[] = []
  for await (const chunk of chunks) buffers.push(chunk)
  return Buffer.concat(buffers).toString('utf8')
}

describe('friendly CSV export', () => {
  it('streams readable values with BOM, quoting, and formula protection', async () => {
    const rows: TransferDataRow[] = [
      {
        name: { kind: 'value', type: 'string', value: '=HYPERLINK("https://evil.test")' },
        amount: { kind: 'value', type: 'decimal', value: '1234567890.123456789' },
        metadata: { kind: 'value', type: 'json', value: { note: 'a,b' } },
        empty: { kind: 'value', type: 'string', value: '' },
        missing: { kind: 'null' },
      },
    ]

    const csv = await collect(encodeFriendlyCsv(
      ['name', 'amount', 'metadata', 'empty', 'missing'],
      (async function* () { yield* rows })(),
      { delimiter: ',', bom: true },
    ))

    expect(csv).toBe(
      '\uFEFFname,amount,metadata,empty,missing\r\n' +
      '"\'=HYPERLINK(""https://evil.test"")",1234567890.123456789,"{""note"":""a,b""}",,\r\n',
    )
  })

  it('protects leading whitespace, tabs, carriage returns, and dangerous headers', async () => {
    const rows: TransferDataRow[] = [{
      '=formula': { kind: 'value', type: 'string', value: '  +1+1' },
      tab: { kind: 'value', type: 'string', value: '\t@SUM(A1:A2)' },
      carriage: { kind: 'value', type: 'string', value: '\r-1' },
    }]

    const csv = await collect(encodeFriendlyCsv(
      ['=formula', 'tab', 'carriage'],
      (async function* () { yield* rows })(),
      { delimiter: ';', bom: false },
    ))

    expect(csv).toBe("'=formula;tab;carriage\r\n'  +1+1;'\t@SUM(A1:A2);\"'\r-1\"\r\n")
  })

  it('requires explicit confirmation before emitting raw formula cells', async () => {
    const rows = (async function* (): AsyncIterable<TransferDataRow> {
      yield { value: { kind: 'value', type: 'string', value: '=1+1' } }
    })()

    const consume = () => collect(encodeFriendlyCsv(
      ['value'],
      rows,
      { delimiter: '\t', bom: false, rawFormulaValues: true },
    ))

    await expect(consume()).rejects.toEqual(new FriendlyCsvError('FORMULA_CONFIRMATION_REQUIRED'))

    const raw = await collect(encodeFriendlyCsv(
      ['value'],
      (async function* (): AsyncIterable<TransferDataRow> {
        yield { value: { kind: 'value', type: 'string', value: '=1+1' } }
      })(),
      {
        delimiter: '\t',
        bom: false,
        rawFormulaValues: true,
        confirmedRawFormulaValues: true,
      },
    ))
    expect(raw).toBe('value\r\n=1+1\r\n')
  })

  it('rejects missing columns and DEFAULT values instead of silently changing data', async () => {
    await expect(collect(encodeFriendlyCsv(
      ['value'],
      (async function* (): AsyncIterable<TransferDataRow> { yield {} })(),
      { delimiter: ',', bom: false },
    ))).rejects.toEqual(new FriendlyCsvError('INVALID_FRIENDLY_CSV'))

    await expect(collect(encodeFriendlyCsv(
      ['value'],
      (async function* (): AsyncIterable<TransferDataRow> {
        yield { value: { kind: 'default' } }
      })(),
      { delimiter: ',', bom: false },
    ))).rejects.toEqual(new FriendlyCsvError('INVALID_FRIENDLY_CSV'))
  })
})
