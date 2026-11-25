import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const DEFAULT_THEME = '#17243A'
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const STEP_LABELS = ['Check your website', 'Create the signing key', 'Prepare the app settings', 'Generate the Android project', 'Build and sign the app', 'Write the verification file']
const CAPTIONS = { web: 'How visitors see your site now.', app: 'How your site will open on Android: no browser bar.', building: 'Building your app.', done: 'Ready for Google Play.' }
const API_BASE_URL = '' // Vite proxies /api to the existing Express server on port 3000.

function normalizeUrl(value) {
  let candidate = value.trim()
  if (!candidate) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`
  try { return new URL(candidate).href } catch { return '' }
}
function hostOf(value) { try { return new URL(value).host } catch { return '' } }
function foregroundFor(hex) {
  if (!/^#[\da-f]{6}$/i.test(hex)) return '#fff'
  const rgb = hex.slice(1).match(/.{2}/g).map(x => parseInt(x, 16) / 255)
  const linear = rgb.map(c => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2] > .4 ? '#111' : '#fff'
}
async function api(path, body) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error('Cannot reach the backend server. Make sure node server.cjs is running.')
  }
  let data = null
  try { data = await response.json() } catch { /* response may not contain JSON */ }
  if (!response.ok) throw new Error(data?.error || `Request failed with status ${response.status}`)
  return data
}
function useRoute() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  const navigate = useCallback((next) => {
    window.history.pushState({}, '', next)
    setPath(next)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])
  return [path, navigate]
}
function Brand({ onHome }) {
  return <a className="brand" href="/" onClick={e => { e.preventDefault(); onHome() }} aria-label="WebToApp home"><span className="brand-mark" aria-hidden="true"><span/><span/><span/><span/></span><span>webto<span className="brand-accent">app</span></span></a>
}
function Topbar({ onHome, setup = false, onGitHub }) {
  return <nav className="topbar" aria-label="Main navigation"><Brand onHome={onHome}/><div className="topbar-right"><span className="secure-label"><span className="secure-dot"/> Secure build workspace</span><a className="top-link" href="/github" onClick={e => { e.preventDefault(); onGitHub?.() }}>GitHub source</a>{setup ? <a className="top-link" href="/" onClick={e => { e.preventDefault(); onHome() }}>Back to website check</a> : <a className="top-link" href="#how-it-works">How it works</a>}</div></nav>
}
function PhonePreview({ state, host, name, theme, progress }) {
  const style = { '--pv-theme': theme || DEFAULT_THEME, '--pv-on': foregroundFor(theme || DEFAULT_THEME), '--progress': `${progress || 0}%` }
  return <aside className="stage" aria-hidden="true"><div className="stage-topline"><span>LIVE APP PREVIEW</span><span className="live-indicator"><i/> LIVE</span></div><div className="preview-card"><div className="preview-card-copy"><span className="preview-label">FROM WEB TO APP</span><h2>One website.<br/>One app experience.</h2><p>See how your app transforms as you move through the build.</p></div><div className="phone-wrap"><div className="phone" data-state={state} style={style}><div className="phone-frame-top"><span className="phone-camera"/><span className="phone-speaker"/></div><div className="status"><span>9:41</span><span className="status-icons">● ▰</span></div><div className="browserbar"><span className="browser-lock">⌑</span><span>{host || 'yoursite.com'}</span><span className="browser-menu">•••</span></div><div className="page"><div className="mock-site-head"><span className="mock-logo"/><span className="mock-menu">☰</span></div><span style={{width:'62%'}}/><span style={{width:'88%'}}/><span style={{width:'74%'}}/><span className="block-bar"/><span style={{width:'80%'}}/><span style={{width:'55%'}}/><span className="mock-cta"/></div><div className="splash"><div className="mark">{state === 'done' ? '✓' : (name?.trim()?.[0] || 'A').toUpperCase()}</div><div className="pv-name">{name || 'Your app'}</div><div className="meter"><span/></div><span className="splash-caption">Starting your experience</span></div><div className="phone-home"/></div></div><div className="preview-foot"><span className="preview-state-dot"/><span className="caption">{CAPTIONS[state]}</span></div></div><div className="preview-benefits"><div><span className="benefit-icon">01</span><span><strong>Check compatibility</strong><small>Know what your website needs.</small></span></div><div><span className="benefit-icon">02</span><span><strong>Configure your app</strong><small>Choose the details that matter.</small></span></div><div><span className="benefit-icon">03</span><span><strong>Build and download</strong><small>Get your Android app bundle.</small></span></div></div></aside>
}
function HowItWorks() {
  const cards = [
    ['01','Enter your website',"Simply paste your website URL. We'll check its compatibility and identify everything needed for an Android app.",'START HERE'],
    ['02','Customize your app','Choose your app name, package ID and other essential settings to give your Android application its own identity.','MAKE IT YOURS'],
    ['03','Let us build it','Our automated build engine uses Bubblewrap to package your website into an Android application and generate your app bundle.','AUTOMATED BUILD'],
    ['04','Download & publish','Download your generated AAB, get your verification files and follow the guided steps to submit your app to Google Play.','YOU’RE READY'],
  ]
  return <section className="how-section" id="how-it-works"><div className="how-header"><span className="how-eyebrow"><span className="how-eyebrow-line"/> SIMPLE. FAST. POWERFUL. <span className="how-eyebrow-line"/></span><h2>From website to app.<span>It's that simple.</span></h2><p>No complicated Android development. No unnecessary technical work. Just follow four simple steps and get your website ready for Google Play.</p></div><div className="how-steps">{cards.map(([n,title,desc,tag]) => <article className="how-card" key={n}><div className="how-card-top"><span className="how-number">{n}</span><span className="how-icon">{n === '01' ? '◎' : n === '02' ? '✣' : n === '03' ? '↓' : '⇩'}</span></div><div className={`how-illustration how-illustration-${n}`}>{n === '01' ? <div className="browser-window"><div className="browser-top"><i/><i/><i/><span>yourwebsite.com</span></div><div className="browser-content"><div className="browser-logo"/><div className="browser-line long"/><div className="browser-line medium"/><div className="browser-button"/></div><div className="scan-line"/></div> : n === '02' ? <div className="config-window"><div className="config-row"><span>App name</span><b/></div><div className="config-row"><span>Package ID</span><b/></div><div className="config-row"><span>Version</span><b/></div><div className="config-check">✓ Configuration ready</div></div> : n === '03' ? <div className="build-orb"><div className="build-ring"/><div className="build-core">✓</div></div> : <div className="download-file"><div className="file-icon">AAB</div><div className="file-details"><strong>your-app.aab</strong><span>Android App Bundle</span></div><div className="file-check">✓</div></div>}</div><h3>{title}</h3><p>{desc}</p><span className="how-tag">{tag}</span></article>)}</div><div className="how-bottom"><div className="how-bottom-copy"><span className="how-bottom-icon">✦</span><span>Four steps. One Android app. No coding required.</span></div><a href="#" className="how-cta" onClick={e => { e.preventDefault(); window.scrollTo({top:0,behavior:'smooth'}) }}>Get started now →</a></div></section>
}
function ScannerPage({ navigate }) {
  const [url, setUrl] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')
  const [report, setReport] = useState(null)
  const [buildDetails, setBuildDetails] = useState({ name:'', shortName:'', packageId:'', versionCode:'1', notifications:false })
  const [buildError, setBuildError] = useState('')
  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState(null)
  const [buildResult, setBuildResult] = useState(null)
  const [phone, setPhone] = useState({state:'web',host:'',name:'',theme:DEFAULT_THEME,progress:0})
  const [jobId, setJobId] = useState('')
  const [copyState, setCopyState] = useState({})
  const startedAt = useRef(0)
  const pollTimer = useRef(null)
  const tickTimer = useRef(null)
  const checkedUrl = useRef('')
  const setField = (key,value) => setBuildDetails(old => ({...old,[key]:value}))
  const clearFlow = useCallback(() => {
    clearTimeout(pollTimer.current); clearInterval(tickTimer.current)
    checkedUrl.current=''; setReport(null); setProgress(null); setBuildResult(null); setBuildError(''); setCheckError('')
    setPhone({state:'web',host:hostOf(normalizeUrl(url)),name:'',theme:DEFAULT_THEME,progress:0})
  }, [url])
  useEffect(() => () => { clearTimeout(pollTimer.current); clearInterval(tickTimer.current) }, [])
  useEffect(() => {
    if (checkedUrl.current && normalizeUrl(url) !== checkedUrl.current) clearFlow()
    else if (!checkedUrl.current) setPhone(old => ({...old,state:'web',host:hostOf(normalizeUrl(url))}))
  }, [url, clearFlow])
  const copyText = async (key,value) => {
    try { await navigator.clipboard.writeText(value); setCopyState(s=>({...s,[key]:'Copied'})) }
    catch { setCopyState(s=>({...s,[key]:'Copy failed'})) }
    window.setTimeout(()=>setCopyState(s=>({...s,[key]:''})),1600)
  }
  const runScan = async e => {
    e.preventDefault(); clearFlow()
    const normalized = normalizeUrl(url)
    if (!normalized) { setCheckError('Enter your website address, like https://yourshop.com.'); return }
    setUrl(normalized); setPhone(p=>({...p,state:'web',host:hostOf(normalized)})); setChecking(true)
    try {
      const scan = await api('/api/pwa/scan',{url:normalized})
      checkedUrl.current=normalized
      const warnings=scan.warnings||[]
      if (scan.status === 'ready') {
        const compatibility=await api('/api/check',{url:normalized})
        setReport({kind:'compatibility',data:compatibility,warnings})
        if (compatibility.ok) {
          setBuildDetails(d=>({...d,name:compatibility.suggested.name,shortName:compatibility.suggested.shortName,packageId:compatibility.suggested.packageId}))
          setPhone({state:'app',host:compatibility.host||hostOf(normalized),name:compatibility.suggested.name,theme:compatibility.themeColor||DEFAULT_THEME,progress:0})
        } else setPhone(p=>({...p,state:'web'}))
      } else {
        setReport({kind:'pwa',data:scan,warnings})
        const website=scan.website||{}
        if (scan.status==='ready') setPhone({state:'app',host:scan.host||hostOf(normalized),name:website.appName||'Your app',theme:website.themeColor||DEFAULT_THEME,progress:0})
        else if (scan.ok) {
          sessionStorage.setItem('webtoapp:pwaSetup',JSON.stringify({url:normalized,scan}))
          setPhone({state:'app',host:scan.host||hostOf(normalized),name:website.appName||website.title||hostOf(normalized),theme:website.themeColor||DEFAULT_THEME,progress:0})
        } else setPhone(p=>({...p,state:'web'}))
      }
    } catch(err) { setCheckError(err.message) }
    finally { setChecking(false) }
  }
  const startBuild = async e => {
    e.preventDefault(); setBuildError('')
    const {name,shortName,packageId,versionCode,notifications}=buildDetails
    if (!name.trim()) return setBuildError('Enter an app name.')
    if (!shortName.trim()||shortName.trim().length>12) return setBuildError('The name under the icon must be 1 to 12 characters.')
    if (!PACKAGE_RE.test(packageId.trim())) return setBuildError('The app ID needs lowercase letters, numbers and underscores, with at least one dot, like com.mycompany.myapp.')
    if (!Number.isInteger(Number(versionCode))||Number(versionCode)<1) return setBuildError('The version number must be a whole number of 1 or more.')
    setBuilding(true)
    try {
      const storageKey=`webtoapp:project:${new URL(checkedUrl.current).origin}:${packageId.trim()}`
      let projectId=null; try { projectId=localStorage.getItem(storageKey) } catch { /* storage optional */ }
      const job=await api('/api/build',{url:checkedUrl.current,name:name.trim(),shortName:shortName.trim(),packageId:packageId.trim(),versionCode:Number(versionCode),notifications,...(projectId?{projectId}:{})})
      if(job.projectId) { try { localStorage.setItem(storageKey,job.projectId) } catch { /* storage optional */ } }
      setJobId(job.id); setProgress({status:'queued',step:0,queueNote:'',elapsed:'0:00',error:''}); setReport(null); setBuildResult(null)
      setPhone(p=>({...p,state:'building',name:name.trim(),progress:0})); startedAt.current=Date.now()
    } catch(err) { setBuildError(err.message) }
    finally { setBuilding(false) }
  }
  useEffect(() => {
    if (!jobId) return undefined
    let stopped=false
    const update=async()=>{
      try {
        const job=await api(`/api/build/${encodeURIComponent(jobId)}`)
        if(stopped) return
        if(job.status==='done') {
          const files=new Map((job.files||[]).map(f=>[f.key,f]))
          setBuildResult({aab:files.get('aab'),files:[...files.entries()].filter(([key])=>key==='assetlinks'||key==='apk').map(([,f])=>f),host:job.result?.host||'',fingerprint:job.result?.fingerprint||''})
          setProgress(null); setJobId(''); setPhone(p=>({...p,state:'done',progress:100})); return
        }
        if(job.status==='failed') { setProgress(p=>({...p,status:'failed',error:job.error||'The build failed.',step:Math.max(0,...(job.log||[]).map(line=>Number(/^([0-9])\/6/.exec(line)?.[1]||0)))})); setJobId(''); setPhone(p=>({...p,state:'app'})); return }
        const step=Math.max(0,...(job.log||[]).map(line=>Number(/^([0-9])\/6/.exec(line)?.[1]||0)))
        const elapsed=Math.floor((Date.now()-startedAt.current)/1000)
        setProgress({status:job.status,step,queueNote:job.status==='queued'?`You are number ${job.position||1} in line.`:'',elapsed:`${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`,error:''})
        setPhone(p=>({...p,state:'building',progress:Math.round(((step||0.5)/6)*100)}))
      } catch(err) { if(!stopped) setProgress(p=>({...p,status:'error',error:err.message})) }
      if(!stopped) pollTimer.current=window.setTimeout(update,2000)
    }
    update()
    tickTimer.current=window.setInterval(()=>setProgress(p=>p?({...p,elapsed:`${Math.floor((Date.now()-startedAt.current)/60000)}:${String(Math.floor((Date.now()-startedAt.current)/1000)%60).padStart(2,'0')}`}):p),1000)
    return ()=>{stopped=true;clearTimeout(pollTimer.current);clearInterval(tickTimer.current)}
  },[jobId])
  const resetAll=()=>{clearFlow();setUrl('');setJobId('');setProgress(null);setBuildResult(null);setPhone({state:'web',host:'',name:'',theme:DEFAULT_THEME,progress:0})}
  const reportData=report?.data
  const scanChecks=report?.kind==='pwa'?Object.entries(reportData?.checks||{}):[]
  const compatibilityItems=report?.kind==='compatibility'?(reportData?.ok?['Loads over HTTPS','Has a web app manifest','Has a 512 by 512 icon']:reportData?.errors||[]):[]
  const continuePwa=()=>{if(!sessionStorage.getItem('webtoapp:pwaSetup')){setCheckError('Please scan your website again before continuing.');return}navigate('/setup')}
  return <><div className="ambient ambient-one" aria-hidden="true"/><div className="ambient ambient-two" aria-hidden="true"/><div className="app-shell"><Topbar onHome={resetAll} onGitHub={() => navigate('/github')}/><main className="layout"><section className="flow" aria-label="Create your Android app"><div className="eyebrow"><span className="eyebrow-line"/> WEBSITE TO ANDROID, SIMPLIFIED</div><header className="intro"><h1>Your website.<br/><span className="headline-accent">An Android app.</span></h1><p className="lede">Go from website to a Google Play-ready Android App Bundle. We check your site, prepare the app and guide you through what comes next.</p><div className="trust-row"><span>✓ Website compatibility check</span><span>✓ Android app bundle</span><span>✓ Guided Play Store setup</span></div></header>
  <div className="workflow-card"><div className="workflow-head"><div><span className="step-kicker">STEP 01 <span className="step-divider">/</span> WEBSITE CHECK</span><h2>Start with your website</h2><p>Enter the live HTTPS address you want to turn into an app.</p></div><div className="step-icon">◎</div></div>
  <form className="address" onSubmit={runScan} noValidate><label htmlFor="url">Website URL</label><div className="url-control"><span className="url-prefix">https://</span><input id="url" value={url} onChange={e=>setUrl(e.target.value)} inputMode="url" autoComplete="url" autoCapitalize="off" spellCheck="false" placeholder="yourwebsite.com"/><button type="submit" className="btn primary" disabled={checking}>{checking?'Scanning…':'Check website'} <span>→</span></button></div><div className="input-meta"><p className="hint">⌑ Your site must be live on HTTPS and have a web app manifest.</p><span className="privacy-note">No account required</span></div>{checkError&&<p className="msg bad" role="alert">{checkError}</p>}</form>
  {report&&<section className="block report-panel" aria-live="polite"><div className="section-rule"><span>COMPATIBILITY REPORT</span><span className="rule-line"/></div><h2>{report.kind==='pwa'?(reportData.status==='needs_https'?'HTTPS is required before PWA preparation.':reportData.status==='ready'?'Your website already meets the PWA checks.':reportData.ok?'Your website needs PWA setup.':'We could not complete the website scan.'):(reportData.ok?'Your site is ready to become an app.':'This site needs a fix first.')}</h2><ul className="checks">{report.kind==='pwa'?scanChecks.map(([key,check])=><li key={key} className={check.passed?'ok':check.required?'bad':''}>{({https:'HTTPS',homepage:'Homepage reachable',manifest:'Web app manifest',manifestValid:'Manifest validity',appName:'App name',appIcon:'App icon',serviceWorker:'Service worker (optional)'})[key]||key}: {check.message}</li>):compatibilityItems.map((item,i)=><li key={i} className={reportData.ok?'ok':'bad'}>{item}</li>)}</ul>{(report.warnings?.length>0||reportData.warnings?.length>0)&&<div className="warning-panel"><h3>Recommended improvements</h3><ul className="notes">{(report.warnings?.length?report.warnings:reportData.warnings).map((w,i)=><li key={i}>{w}</li>)}</ul></div>}{report.kind==='pwa'&&reportData.ok&&reportData.status!=='ready'&&<div className="pwa-continue-wrap"><p className="hint">Your website is reachable. Complete the PWA details on the next page to prepare its setup files.</p><button className="btn primary" type="button" onClick={continuePwa}>Continue to PWA setup →</button></div>}</section>}
  {report?.kind==='compatibility'&&reportData.ok&&<form className="block details-panel" onSubmit={startBuild} noValidate><div className="section-rule"><span>STEP 02 / APP CONFIGURATION</span><span className="rule-line"/></div><div className="panel-heading"><div><h2>Make it yours</h2><p>These details will identify your app on Android.</p></div><span className="ready-pill"><span/> Website passed</span></div><div className="form-grid"><div className="field field-wide"><label htmlFor="app-name">App name</label><input id="app-name" maxLength="50" value={buildDetails.name} onChange={e=>{setField('name',e.target.value);setPhone(p=>({...p,name:e.target.value}))}} placeholder="My Business App"/><p className="hint">The name shown in your app and Play Store listing.</p></div><div className="field"><label htmlFor="short-name">Name under the icon</label><input id="short-name" maxLength="12" value={buildDetails.shortName} onChange={e=>setField('shortName',e.target.value)} placeholder="MyApp"/><p className="hint">Keep it to 12 characters or fewer.</p></div><div className="field"><label htmlFor="version">Version code</label><input id="version" type="number" min="1" step="1" value={buildDetails.versionCode} onChange={e=>setField('versionCode',e.target.value)}/><p className="hint">Increase this number for every update.</p></div><div className="field field-wide"><label htmlFor="package-id">Android package ID <span className="label-tag">Permanent after publishing</span></label><input id="package-id" className="mono" value={buildDetails.packageId} onChange={e=>setField('packageId',e.target.value)} placeholder="com.yourcompany.yourapp"/><p className="hint">Use lowercase letters, numbers and underscores, separated by dots.</p></div></div><label className="check notification-option"><input type="checkbox" checked={buildDetails.notifications} onChange={e=>setField('notifications',e.target.checked)}/><span className="custom-check"/><span><strong>Enable notification permission prompt</strong><small>Ask visitors for notification permission when supported by your website.</small></span></label>{buildError&&<p className="msg bad" role="alert">{buildError}</p>}<div className="form-footer"><span className="footer-note">Your app settings are used for this build.</span><button className="btn primary" type="submit" disabled={building}>{building?'Starting…':'Generate Android app →'}</button></div></form>}
  {progress&&<section className="block progress-panel"><div className="section-rule"><span>STEP 03 / BUILDING</span><span className="rule-line"/></div><div className="panel-heading"><div><h2>Your app is being generated</h2><p className="hint">{progress.queueNote} Usually 2 to 4 minutes. Keep this tab open. Elapsed {progress.elapsed}.</p></div><span className="build-orbit"><span/></span></div><ol className="steps">{STEP_LABELS.map((label,i)=>{const n=i+1;const cls=progress.status==='failed'&&progress.step===n?'failed':progress.status==='done'||n<progress.step?'done':n===progress.step?'current':'todo';return <li key={label} className={cls}>{label}</li>})}</ol>{progress.error&&<p className="msg bad" role="alert">{progress.error}</p>}</section>}
  {buildResult&&<section className="block result-panel"><div className="success-banner"><span className="success-icon">✓</span><span>BUILD COMPLETE</span></div><h2>Your Android app is ready.</h2><p className="result-lede">Your app bundle has been generated. Download your files and follow the setup steps below to prepare for Google Play.</p>{buildResult.aab&&<a className="btn primary download-button" href={buildResult.aab.url} download={buildResult.aab.name}>↓ Download app bundle <span>.AAB</span></a>}<p className="hint">This is the Android App Bundle file requested by Google Play Console.</p><div className="next-steps"><div className="section-rule"><span>YOUR NEXT STEPS</span><span className="rule-line"/></div><ol className="next"><li><span className="next-number">01</span><div><strong>Publish the verification file</strong><p>Host <code>assetlinks.json</code> at this address on your website:</p><span className="copyline"><code>{`https://${buildResult.host}/.well-known/assetlinks.json`}</code><button className="link" onClick={()=>copyText('url',`https://${buildResult.host}/.well-known/assetlinks.json`)}>{copyState.url||'Copy address'}</button></span><p className="step-explain">This verifies your website and helps remove the browser bar from your app.</p></div></li><li><span className="next-number">02</span><div><strong>Upload your AAB to Play Console</strong><p>Create your app in Google Play Console, then upload the downloaded bundle to a testing or production track.</p></div></li><li><span className="next-number">03</span><div><strong>Add your Play App Signing fingerprint</strong><p>After your first upload, find the app signing key in Play Console → App integrity and add its fingerprint to <code>assetlinks.json</code>, alongside this one:</p><span className="copyline"><code className="fp">{buildResult.fingerprint}</code><button className="link" onClick={()=>copyText('fp',buildResult.fingerprint)}>{copyState.fp||'Copy fingerprint'}</button></span></div></li></ol></div><div className="other-files-panel"><h3>Build files</h3><ul className="files">{buildResult.files.map(f=><li key={f.key}><a href={f.url} download={f.name}>{f.key==='assetlinks'?'assetlinks.json':'Test app (.apk)'}</a></li>)}</ul></div><p className="note">Keep your signing key and its password in a safe place. You need them to publish future updates. Files on this server are deleted after one hour.</p><button className="btn secondary again-button" onClick={resetAll}>Create another app</button></section>}
  </div></section><PhonePreview {...phone}/></main><HowItWorks/><footer className="page-footer"><span>Built for the open web.</span><span>WebToApp <span className="footer-separator">·</span> Website to Android</span></footer></div></>
}

function GitHubSourcePage({ navigate }) {
  const [status, setStatus] = useState(null)
  const [repositories, setRepositories] = useState([])
  const [repository, setRepository] = useState('')
  const [branches, setBranches] = useState([])
  const [branch, setBranch] = useState('')
  const [tree, setTree] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [loadingTree, setLoadingTree] = useState(false)
  const [sourceFiles, setSourceFiles] = useState([])
  const [loadingFiles, setLoadingFiles] = useState(false)

  const loadRepositories = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [connection, result] = await Promise.all([
        api('/api/integrations/github/status'),
        api('/api/integrations/github/repositories')
      ])
      setStatus(connection)
      setRepositories(result.repositories || [])
      // When there is only one repository, it is selected automatically.
      // Load its branches here as well; setting the select value does not fire onChange.
      if (result.repositories?.length === 1) {
        const selectedRepository = result.repositories[0].fullName
        setRepository(selectedRepository)
        setLoadingBranches(true)
        try {
          const branchResult = await api(`/api/integrations/github/branches?repository=${encodeURIComponent(selectedRepository)}`)
          setBranches(branchResult.branches || [])
        } catch (branchError) {
          setError(branchError.message)
        } finally {
          setLoadingBranches(false)
        }
      }
    } catch (err) {
      setError(err.message)
      try { setStatus(await api('/api/integrations/github/status')) } catch { /* keep status unavailable */ }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadRepositories() }, [loadRepositories])

  const loadBranches = async (fullName) => {
    setRepository(fullName)
    setBranches([])
    setBranch('')
    setTree(null)
    setError('')
    if (!fullName) return
    setLoadingBranches(true)
    try {
      const result = await api(`/api/integrations/github/branches?repository=${encodeURIComponent(fullName)}`)
      setBranches(result.branches || [])
      if (result.branches?.length === 1) setBranch(result.branches[0].name)
    } catch (err) { setError(err.message) }
    finally { setLoadingBranches(false) }
  }

  const inspectSource = async () => {
    if (!repository || !branch) return
    setLoadingTree(true)
    setError('')
    setTree(null)
    try {
      const result = await api(`/api/integrations/github/tree?repository=${encodeURIComponent(repository)}&branch=${encodeURIComponent(branch)}`)
      setTree(result)
    } catch (err) { setError(err.message) }
    finally { setLoadingTree(false) }
  }

  const folders = useMemo(() => (tree?.entries || []).filter(item => item.type === 'tree'), [tree])
  const files = useMemo(() => (tree?.entries || []).filter(item => item.type === 'blob'), [tree])

  return <><div className="ambient ambient-one"/><div className="ambient ambient-two"/><div className="app-shell github-source-page">
    <Topbar onHome={() => navigate('/')} onGitHub={() => navigate('/github')}/>
    <main className="github-main">
      <div className="eyebrow"><span className="eyebrow-line"/> GITHUB INTEGRATION</div>
      <header className="github-intro"><h1>Your code.<br/><span className="headline-accent">One workspace.</span></h1><p className="lede">Choose a repository and branch. WebToApp will inspect the source structure without changing any files.</p></header>
      <section className="workflow-card github-card">
        <div className="panel-heading"><div><h2>GitHub connection</h2><p>Read-only repository inspection for this stage.</p></div><span className="ready-pill"><span/>{status?.connected ? 'Connected' : 'Checking'}</span></div>
        {status?.connected ? <div className="github-account"><span className="github-avatar">GH</span><span><strong>{status.account}</strong><small>GitHub account connected · Installation {status.installationId}</small></span></div> : <div className="github-connect"><p>{loading ? 'Checking your GitHub session…' : 'Connect your GitHub account to browse your repositories.'}</p><a className="btn primary" href="/api/integrations/github/authorize">Connect GitHub →</a></div>}
        {error && <p className="msg bad" role="alert">{error}</p>}
        {status?.connected && <>
          <div className="github-field">
            <label htmlFor="github-repository">1. Select repository</label>
            <select id="github-repository" value={repository} onChange={e => loadBranches(e.target.value)} disabled={loading || repositories.length === 0}>
              <option value="">Choose a repository</option>
              {repositories.map(repo => <option value={repo.fullName} key={repo.id}>{repo.fullName}{repo.private ? ' · Private' : ' · Public'}</option>)}
            </select>
            <p className="hint">{repositories.length} accessible {repositories.length === 1 ? 'repository' : 'repositories'} found.</p>
          </div>
          {repository && <div className="github-field">
            <label htmlFor="github-branch">2. Select branch</label>
            <select id="github-branch" value={branch} onChange={e => {setBranch(e.target.value);setTree(null)}} disabled={loadingBranches || branches.length === 0}>
              <option value="">{loadingBranches ? 'Loading branches…' : 'Choose a branch'}</option>
              {branches.map(item => <option value={item.name} key={item.name}>{item.name}</option>)}
            </select>
          </div>}
          {branch && <div className="github-inspect-action"><button className="btn primary" type="button" onClick={inspectSource} disabled={loadingTree}>{loadingTree ? 'Inspecting source…' : 'Inspect repository source →'}</button><span className="footer-note">Read-only · No files will be changed</span></div>}
        </>}
      </section>
      {tree && <section className="workflow-card github-results" aria-live="polite">
        <div className="github-result-heading"><div><span className="step-kicker">SOURCE INSPECTION COMPLETE</span><h2>{tree.repository}</h2><p>Branch: <code>{tree.branch}</code> · Commit: <code>{tree.commitSha?.slice(0, 10)}</code></p></div><span className="ready-pill"><span/> Read-only</span></div>
        <div className="github-summary-grid"><div><small>Detected technology</small><strong>{tree.framework}</strong></div><div><small>Repository entries</small><strong>{tree.totalEntries}</strong></div><div><small>Folders</small><strong>{folders.length}</strong></div><div><small>Files</small><strong>{files.length}</strong></div></div>
        {tree.truncated && <p className="note">GitHub returned a large repository tree. Showing the first {tree.entries.length} entries.</p>}
        <div className="github-file-list"><h3>Repository structure</h3>{tree.entries.map((entry, index) => <div className="github-file-row" key={entry.path}><span className="github-file-kind">{entry.type === 'tree' ? '▰' : '◇'}</span><code>{entry.path}</code><span>{entry.type === 'tree' ? 'Folder' : entry.size ? `${Math.ceil(entry.size / 1024)} KB` : 'File'}</span></div>)}</div>
        <div className="github-inspect-action">
          <button className="btn primary" type="button" onClick={readProjectFiles} disabled={loadingFiles}>
            {loadingFiles ? 'Reading project files…' : 'Read project configuration →'}
          </button>
          <span className="footer-note">Read-only · Sensitive files and binary assets are excluded</span>
        </div>
        {sourceFiles.length > 0 && <div className="github-file-list github-source-content">
          <h3>Source files read ({sourceFiles.length})</h3>
          {sourceFiles.map(file => <details className="github-source-file" key={file.path}>
            <summary><code>{file.path}</code><span>{Math.ceil(file.size / 1024)} KB</span></summary>
            <pre>{file.content}</pre>
          </details>)}
        </div>}
        <p className="hint">Repository tree and selected text configuration files are read-only. No customer files are changed.</p>
      </section>}
      <div className="github-back"><button className="btn secondary" type="button" onClick={() => navigate('/')}>← Back to website check</button><button className="link" type="button" onClick={loadRepositories}>Refresh repositories</button></div>
    </main>
  </div></>
}

function PwaSetupPage({ navigate }) {
  const [setup,setSetup]=useState(null)
  const [values,setValues]=useState({name:'',shortName:'',description:'',display:'standalone',theme:'#17243A',background:'#ffffff',serviceWorker:false})
  const [logo,setLogo]=useState(null)
  const [logoName,setLogoName]=useState('No logo selected.')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [result,setResult]=useState(null)
  const set=(key,value)=>setValues(old=>({...old,[key]:value}))
  useEffect(()=>{
    let stored=null;try{stored=JSON.parse(sessionStorage.getItem('webtoapp:pwaSetup')||'null')}catch{/* invalid session */}
    if(!stored?.url||!stored?.scan?.ok){navigate('/');return}
    setSetup(stored)
    const site=stored.scan.website||{}
    const detected=site.appName||site.title||new URL(stored.url).hostname
    setValues({name:detected.slice(0,50),shortName:detected.slice(0,12),description:`${detected} application`.slice(0,300),display:'standalone',theme:/^#[\da-f]{6}$/i.test(site.themeColor||'')?site.themeColor:'#17243A',background:/^#[\da-f]{6}$/i.test(site.backgroundColor||'')?site.backgroundColor:'#ffffff',serviceWorker:false})
    try {const saved=JSON.parse(sessionStorage.getItem('webtoapp:pwaResult')||'null');if(saved?.url===stored.url&&saved.result)setResult(saved.result)}catch{/* ignore */}
  },[navigate])
  const submit=async e=>{
    e.preventDefault();setError('')
    if(!logo)return setError('Choose your app logo before generating the package.')
    if(!['image/png','image/jpeg','image/webp'].includes(logo.type))return setError('Use a PNG, JPEG or WebP image.')
    if(logo.size>5*1024*1024)return setError('Your logo must be 5 MB or smaller.')
    if(!values.name.trim()||values.name.trim().length>50)return setError('Enter an app name between 1 and 50 characters.')
    if(!values.shortName.trim()||values.shortName.trim().length>12)return setError('Enter a short name between 1 and 12 characters.')
    setBusy(true)
    try{
      const iconBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(new Error('Could not read the selected logo.'));reader.readAsDataURL(logo)})
      const generated=await api('/api/pwa/package',{url:setup.url,settings:{name:values.name.trim(),shortName:values.shortName.trim(),description:values.description.trim(),display:values.display,themeColor:values.theme,backgroundColor:values.background},iconBase64,includeServiceWorker:values.serviceWorker})
      if(generated?.status!=='done'||!generated.downloadUrl)throw new Error('The package was created, but the server did not return a download link.')
      setResult(generated);sessionStorage.setItem('webtoapp:pwaResult',JSON.stringify({url:setup.url,result:generated}))
    }catch(err){setError(err.message||'Could not generate the PWA setup package.')}finally{setBusy(false)}
  }
  const downloadUrl=result?new URL(result.downloadUrl,window.location.origin).href:''
  return <><div className="ambient ambient-one"/><div className="ambient ambient-two"/><div className="app-shell pwa-setup-page"><Topbar setup onHome={()=>navigate('/')} onGitHub={() => navigate('/github')}/><main className="pwa-page-main"><div className="eyebrow"><span className="eyebrow-line"/> STEP 02 / PWA PREPARATION</div><header className="pwa-page-intro"><h1>Prepare your website<br/><span className="headline-accent">for an app.</span></h1><p className="lede">Add your app details, choose its appearance and generate the PWA setup files. Your website hosting will not be changed automatically.</p></header><section className="workflow-card pwa-page-card"><div className="panel-heading"><div><h2>PWA configuration</h2><p>{setup?.url||'Configure the details for your website.'}</p></div><span className="ready-pill pwa-needed-pill"><span/> Setup needed</span></div><form className="pwa-form" onSubmit={submit} noValidate><div className="form-grid"><div className="field field-wide"><label htmlFor="pwa-name">App name</label><input id="pwa-name" maxLength="50" required value={values.name} onChange={e=>set('name',e.target.value)} placeholder="My Business"/></div><div className="field"><label htmlFor="pwa-short-name">Short name</label><input id="pwa-short-name" maxLength="12" required value={values.shortName} onChange={e=>set('shortName',e.target.value)} placeholder="MyApp"/><p className="hint">12 characters or fewer.</p></div><div className="field"><label htmlFor="pwa-display">Display mode</label><select id="pwa-display" value={values.display} onChange={e=>set('display',e.target.value)}><option value="standalone">Standalone (recommended)</option><option value="fullscreen">Fullscreen</option><option value="minimal-ui">Minimal UI</option><option value="browser">Browser</option></select></div><div className="field field-wide"><label htmlFor="pwa-description">Description</label><input id="pwa-description" maxLength="300" value={values.description} onChange={e=>set('description',e.target.value)} placeholder="Describe your app"/></div><div className="field"><label htmlFor="pwa-theme">Theme colour</label><input id="pwa-theme" type="color" value={values.theme} onChange={e=>set('theme',e.target.value)}/></div><div className="field"><label htmlFor="pwa-background">Background colour</label><input id="pwa-background" type="color" value={values.background} onChange={e=>set('background',e.target.value)}/></div><div className="field field-wide"><label htmlFor="pwa-logo">App logo</label><input id="pwa-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const f=e.target.files?.[0]||null;setLogo(f);setLogoName(f?`${f.name} · ${(f.size/1024).toFixed(1)} KB`:'No logo selected.')}}/><p className="hint">Upload a PNG, JPEG or WebP logo up to 5 MB. We'll create 192×192 and 512×512 PNG icons.</p><div className="file-selection" aria-live="polite">{logoName}</div></div></div><label className="check notification-option pwa-sw-option"><input type="checkbox" checked={values.serviceWorker} onChange={e=>set('serviceWorker',e.target.checked)}/><span className="custom-check"/><span><strong>Include a service worker starter file</strong><small>Optional template. It must be reviewed and installed on your website by its owner.</small></span></label>{error&&<p className="msg bad" role="alert">{error}</p>}<div className="form-footer"><span className="footer-note">Your website files won't be changed automatically.</span><button className="btn primary" type="submit" disabled={busy}>{busy?'Generating package…':'Generate PWA setup ZIP'}</button></div></form>{result&&<section className="block pwa-result" aria-live="polite"><div className="success-banner"><span className="success-icon">✓</span><span>PWA PACKAGE READY</span></div><h2>Your PWA setup files are ready.</h2><p className="result-lede">Download and extract the ZIP, then upload the included files to your website hosting. WebToApp cannot change your hosting files from a URL alone.</p><a className="btn primary download-button" href={downloadUrl} download={result.filename||'WebToApp-PWA-Setup.zip'}>Download PWA setup <span>.ZIP</span></a><div className="pwa-direct-link"><div className="pwa-direct-link-heading"><span>Direct download link</span><button className="btn secondary pwa-copy-link" type="button" onClick={()=>navigator.clipboard.writeText(downloadUrl)}>Copy link</button></div><a href={downloadUrl} target="_blank" rel="noopener noreferrer">{downloadUrl}</a></div><div className="pwa-upload-steps"><h3>What to do next</h3><ol><li>Extract the ZIP on your computer.</li><li>Upload <code>manifest.webmanifest</code> and the <code>icons</code> folder to your website's public root.</li><li>Follow <code>integration/html-instructions.txt</code> to add the manifest link and theme colour to your homepage.</li><li>After publishing the changes, return to Page 1 and rescan your website.</li></ol></div><p className="msg" role="status">{result.filename||'WebToApp-PWA-Setup.zip'} · {Number(result.sizeKB||0).toFixed(2)} KB · {(result.files||[]).length} files</p><button className="btn secondary" onClick={()=>{sessionStorage.removeItem('webtoapp:pwaSetup');sessionStorage.removeItem('webtoapp:pwaResult');navigate('/')}}>Return to website check</button></section>}</section><p className="pwa-page-footnote"><a href="/" onClick={e=>{e.preventDefault();navigate('/')}}>← Back to Page 1</a><span>WebToApp · PWA preparation</span></p></main></div></>
}
export default function App(){
  const [path,navigate]=useRoute()
  const current = path.replace(/\/$/,'')
  if (current === '/setup') return <PwaSetupPage navigate={navigate}/>
  if (current === '/github') return <GitHubSourcePage navigate={navigate}/>
  return <ScannerPage navigate={navigate}/>
}
