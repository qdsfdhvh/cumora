import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { isElectron } from './lib/runtime'
import { bootNative, isNativePlatform } from './lib/native'
import './styles/globals.css'
import '@/lib/theme'
import { bootMotionPolicy } from '@/lib/motionPolicy'

if (isElectron) document.body.classList.add('electron')
if (isNativePlatform()) document.body.classList.add('native', `native-${typeof window !== 'undefined' && (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() || ''}`)

// Personal build: no analytics, no cloud telemetry.
void bootNative()
// Ambient decoration only animates while someone is looking at the window.
bootMotionPolicy()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
