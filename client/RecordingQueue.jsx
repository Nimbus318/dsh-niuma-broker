import React from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useModels } from './Composer.jsx'
import { useI18n } from './i18n.jsx'

const jobLabel = (job) => [job?.company, job?.title].filter(Boolean).join(' · ')

function Review({ item, opportunities, config, busy, onClose, onOpenJob, act }) {
  const { t } = useI18n()
  const linkedJob = opportunities.find(job => job.id === item.opportunityId)
  const [pickedJobId, setPickedJobId] = React.useState('')
  const [typedRound, setTypedRound] = React.useState('')
  const catalog = useModels()
  const jobId = linkedJob?.id || pickedJobId
  const round = item.round?.trim() || typedRound.trim()
  const model = config?.model
    || catalog.rows.find(row => row.route.startsWith('deepseek-official:'))?.route
    || catalog.rows[0]?.route || ''
  const ready = !busy && !!(jobId && round && model)
  const submit = async (event) => {
    event.preventDefault()
    if (!ready) return
    const reply = await act('recording-debrief', { id: item.id, opportunityId: jobId, round, model }, t('recordings.toastSaved'))
    if (reply?.ok && reply.result?.opportunityId) onOpenJob?.(reply.result.opportunityId, 'debrief')
  }
  return <form className="ca-recording-review ca-form" onSubmit={submit}>
    {!linkedJob && !opportunities.length ? <p className="ca-meta">{t('recordings.needJobFirst')}</p> : <>
      {(!linkedJob || !item.round) && <div className="ca-recording-fields">
        {!linkedJob && <label>{t('recordings.linkedJob')}
          <select value={pickedJobId} onChange={event => setPickedJobId(event.target.value)} required disabled={!!busy}>
            <option value="">{t('recordings.chooseJob')}</option>
            {opportunities.map(job => <option key={job.id} value={job.id}>{jobLabel(job)}</option>)}
          </select>
        </label>}
        {!item.round && <label>{t('recordings.round')}
          <input value={typedRound} onChange={event => setTypedRound(event.target.value)} placeholder={t('recordings.roundPlaceholder')} maxLength={100} required disabled={!!busy} />
        </label>}
      </div>}
      {!catalog.pending && !model && <p className="ca-form-error">{t('recordings.needModel')}</p>}
    </>}
    <div className="ca-recording-actions">
      <Button variant="ghost" size="sm" disabled={!!busy}
        onClick={() => act('recording-dismiss', { id: item.id }, t('recordings.toastDismissed'))}>{t('common.dismiss')}</Button>
      <Button variant="ghost" size="sm" disabled={!!busy} onClick={onClose}>{t('common.cancel')}</Button>
      <Button type="submit" variant="primary" size="sm" disabled={!ready}>
        {busy === 'recording-debrief' ? t('recordings.generating') : t('recordings.generateDebrief')}
      </Button>
    </div>
  </form>
}

export default function RecordingQueue({ recordings, opportunities, config, busy, act, onOpenJob }) {
  const { t, formatDate } = useI18n()
  const heading = React.useId()
  const [expanded, setExpanded] = React.useState('')
  const jobs = Array.isArray(opportunities) ? opportunities.filter(job => job?.id && jobLabel(job)) : []
  const jobIds = new Set(jobs.map(job => job.id))
  // Recordings already linked to an active opportunity live inside that job's detail view;
  // this intake queue only surfaces pending-attribution recordings that still need a job assignment.
  const rows = Array.isArray(recordings?.interviews)
    ? recordings.interviews.filter(item => item?.id && (!item.opportunityId || !jobIds.has(item.opportunityId)))
    : []
  if (!rows.length) return null
  return <section className="ca-recording-queue ca-section" aria-labelledby={heading}>
    <div className="ca-section-head">
      <h2 id={heading}>{t('recordings.sectionTitle')}</h2>
      <Tag tone="info">{t('recordings.readyCount', { count: rows.length })}</Tag>
    </div>
    <div className="ca-recording-list">
      {rows.map(item => {
        const open = expanded === item.id && item.available !== false
        const job = jobs.find(row => row.id === item.opportunityId)
        const time = formatDate(item.occurredAt, { timezone: config?.timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        const detail = [item.sourceName, time, item.round].filter(Boolean).join(' · ')
        return <article key={item.id} className="ca-recording-item" data-open={open}>
          <div className="ca-recording-row">
            <span className="ca-recording-icon" aria-hidden="true"><i /><i /><i /></span>
            <div className="ca-recording-main">
              <div className="ca-inline">
                <h3>{item.title || jobLabel(job) || t('recordings.defaultTitle')}</h3>
                <StateDot state={item.available === false ? 'warning' : 'done'} size={7} />
              </div>
              {detail && <p className="ca-meta">{detail}</p>}
              {item.available === false && <p className="ca-meta">{t('recordings.sourceUnavailable')}</p>}
            </div>
            {item.available === false ? <Button variant="ghost" size="sm" disabled={!!busy}
              onClick={() => act('recording-dismiss', { id: item.id }, t('recordings.toastDismissed'))}>{t('common.dismiss')}</Button>
              : <Button variant="outline" size="sm" disabled={!!busy} aria-expanded={open}
                onClick={() => setExpanded(open ? '' : item.id)}>{open ? t('common.collapse') : t('recordings.oneClickDebrief')}</Button>}
          </div>
          {open && <Review item={item} opportunities={jobs} config={config} busy={busy} act={act} onOpenJob={onOpenJob}
            onClose={() => setExpanded('')} />}
        </article>
      })}
    </div>
  </section>
}
