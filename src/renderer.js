const titleElement = document.getElementById('track-title');
const bodyElement = document.getElementById('lyrics-body');
const sourceElement = document.getElementById('source');

function applyOverlaySettings(settings) {
  if (!document.body.classList.contains('overlay-mode')) return;

  const container = document.getElementById('lyrics-container');
  container.style.opacity = String(settings.opacity);
  bodyElement.style.fontSize = `${settings.fontSize}px`;
  bodyElement.style.fontFamily = settings.fontFamily;
  titleElement.style.fontFamily = settings.fontFamily;
}

function applySettingsForm(settings) {
  const opacity = document.getElementById('opacity');
  if (!opacity) return;

  const fontSize = document.getElementById('fontSize');
  const fontFamily = document.getElementById('fontFamily');
  const pollingMs = document.getElementById('pollingMs');

  opacity.value = settings.opacity;
  fontSize.value = settings.fontSize;
  fontFamily.value = settings.fontFamily;
  pollingMs.value = settings.pollingMs;

  document.getElementById('opacity-output').value = `${Math.round(settings.opacity * 100)}%`;
  document.getElementById('font-size-output').value = `${settings.fontSize}px`;
}

function bindSettingsForm() {
  const opacity = document.getElementById('opacity');
  if (!opacity) return;

  const fontSize = document.getElementById('fontSize');
  const fontFamily = document.getElementById('fontFamily');
  const pollingMs = document.getElementById('pollingMs');

  opacity.addEventListener('input', async (event) => {
    const value = Number(event.target.value);
    document.getElementById('opacity-output').value = `${Math.round(value * 100)}%`;
    await window.overlayApi.setSetting('opacity', value);
  });

  fontSize.addEventListener('input', async (event) => {
    const value = Number(event.target.value);
    document.getElementById('font-size-output').value = `${value}px`;
    await window.overlayApi.setSetting('fontSize', value);
  });

  fontFamily.addEventListener('change', async (event) => {
    await window.overlayApi.setSetting('fontFamily', event.target.value.trim() || 'Inter, Arial, sans-serif');
  });

  pollingMs.addEventListener('change', async (event) => {
    const value = Math.max(1000, Number(event.target.value) || 3000);
    await window.overlayApi.setSetting('pollingMs', value);
  });
}

window.overlayApi.onLyricsUpdate((payload) => {
  if (!titleElement || !bodyElement) return;

  titleElement.textContent = payload.title || 'Unknown track';
  bodyElement.textContent = payload.body || '';
  sourceElement.textContent = payload.source ? `Source: ${payload.source}` : '';
});

window.overlayApi.onSettingsUpdate((settings) => {
  applyOverlaySettings(settings);
  applySettingsForm(settings);
});

window.overlayApi.getSettings().then((settings) => {
  applyOverlaySettings(settings);
  applySettingsForm(settings);
  bindSettingsForm();
});
