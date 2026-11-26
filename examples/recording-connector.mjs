export const name = 'career-broker-recording-example'
export const inject = ['careerBroker']

// This optional connector uses synthetic records. A device connector keeps its
// actual audio and transcript store and implements the same two reads.
export function apply(ctx) {
  const sourceId = 'recording-example'
  const occurredAt = new Date(Date.now() - 60_000).toISOString()
  const examples = [
    {
      recordingId: 'example-work', kind: 'work', occurredAt,
      segments: [
        { speaker: 'candidate', text: '我在周会里核对了三组容量数据，并在同一天修正了上线清单。' },
        { speaker: 'other', text: '另一位同事负责了示例发布，和候选人无关。' },
      ],
    },
    {
      recordingId: 'example-interview', kind: 'interview', occurredAt, title: '示例技术面试', round: '技术面',
      segments: [
        { speaker: 'other', text: '你如何校验多个环境的容量计划？' },
        { speaker: 'candidate', text: '我先核对同一口径，再对异常环境复测。' },
        { speaker: 'unknown', text: '这句发言人的身份未确认。' },
      ],
    },
  ]
  ctx.effect(() => {
    const connector = ctx.careerBroker.registerTranscriptSource({
      id: sourceId, name: '录音接入示例（合成）', kinds: ['work', 'interview'],
      async listRecordings({ since, limit, signal }) {
        signal.throwIfAborted()
        return examples.filter(row => row.occurredAt >= since).slice(0, limit)
          .map(({ recordingId, kind, occurredAt, title, round }) => ({ recordingId, kind, occurredAt, title, round }))
      },
      async readTranscript(recordingId, { signal }) {
        signal.throwIfAborted()
        const item = examples.find(row => row.recordingId === recordingId)
        if (!item) throw new Error('找不到示例转写。')
        return { segments: item.segments }
      },
    })
    const stop = ctx.on('career-broker/event', event => {
      if (event.type === 'recording.source-changed' && event.sourceId === sourceId && event.enabled) {
        // Example push delivery. In production this runs when a new source
        // recording is ready. The same ID may also return from listRecordings.
        const { recordingId, kind, occurredAt } = examples[0]
        void connector.publish({ recordingId, kind, occurredAt }).catch(() => {})
      }
    })
    return () => { stop(); connector.dispose() }
  })
}
