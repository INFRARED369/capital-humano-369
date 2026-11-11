/**
 * 369 CAPITAL HUMANO - LANDING DE RECLUTAMIENTO POR VACANTE
 * Motor de Píxeles (Meta Ads + Google Ads / GA4), Filtro de Candidatos y Agenda de Entrevista
 */

const PIXEL_CONFIG = {
  META_PIXEL_ID: '123456789012345',      // Reemplazar con ID real de Meta Pixel
  GOOGLE_ADS_ID: 'AW-123456789',         // Reemplazar con ID real de Google Ads
  GOOGLE_CONVERSION_LABEL: 'AbCdEfGhIj', // Etiqueta de conversión de Google Ads
  GA4_MEASUREMENT_ID: 'G-369CAPITAL',    // ID de Google Analytics 4
  WHATSAPP_RECRUITER: '528119942627',    // 8119942627 (Hilaria Escobar - Capital Humano)
  VACANCY_CODE: 'VAC-MTY-SMART-01',
  VACANCY_TITLE: 'Agente Smart - Ventas Telecomunicaciones (Llamada y Chat)'
};

// Captura de parámetros UTM y Click IDs (fbclid, gclid)
function getTrafficAttribution() {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source: params.get('utm_source') || 'directo',
    utm_medium: params.get('utm_medium') || 'organico',
    utm_campaign: params.get('utm_campaign') || 'vacante_agente_smart_mty',
    utm_content: params.get('utm_content') || '',
    fbclid: params.get('fbclid') || '',
    gclid: params.get('gclid') || ''
  };
}

const ATTRIBUTION = getTrafficAttribution();

// Registro visual en el Monitor de Píxeles (Modo Demo) y disparo real a Meta / Google
function trackMarketingEvent(eventName, eventData = {}, platforms = ['meta', 'google']) {
  const payload = {
    vacancy_id: PIXEL_CONFIG.VACANCY_CODE,
    vacancy_name: PIXEL_CONFIG.VACANCY_TITLE,
    sector: 'Telecomunicaciones',
    city: 'Monterrey, N.L.',
    ...ATTRIBUTION,
    ...eventData
  };

  // 1. Disparo Meta Pixel (fbq)
  if (platforms.includes('meta') && typeof window.fbq === 'function') {
    const standardMetaEvents = ['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Schedule', 'CompleteRegistration'];
    if (standardMetaEvents.includes(eventName)) {
      window.fbq('track', eventName, payload);
    } else {
      window.fbq('trackCustom', eventName, payload);
    }
  }

  // 2. Disparo Google Ads / GA4 (gtag + dataLayer)
  if (platforms.includes('google')) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: `369_${eventName}`,
      ...payload
    });

    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, payload);
      if (eventName === 'Schedule') {
        window.gtag('event', 'conversion', {
          send_to: `${PIXEL_CONFIG.GOOGLE_ADS_ID}/${PIXEL_CONFIG.GOOGLE_CONVERSION_LABEL}`,
          value: payload.value || 150.0,
          currency: 'MXN'
        });
      }
    }
  }

  // 3. Actualizar Monitor Visual de Píxeles en pantalla
  const logContainer = document.getElementById('pixelLogList');
  if (logContainer) {
    const item = document.createElement('div');
    item.className = 'pixel-log-item';
    const time = new Date().toLocaleTimeString('es-MX', { hour12: false });
    item.innerHTML = `
      <span>
        <span class="pixel-tag-meta">[Meta]</span>
        <span class="pixel-tag-google">[Google]</span>
        <strong>${eventName}</strong>
      </span>
      <span style="color:#94a3b8;">${time}</span>
    `;
    logContainer.prepend(item);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Disparar PageView inicial con atribución UTM
  trackMarketingEvent('PageView', { page_type: 'VacancyLandingPage' });

  // Mostrar atribución detectada en el monitor
  const utmDisplay = document.getElementById('utmDetectedBadge');
  if (utmDisplay) {
    utmDisplay.textContent = `Fuente: ${ATTRIBUTION.utm_source} | Campaña: ${ATTRIBUTION.utm_campaign}`;
  }

  initVideoPlayer();
  initEarningsCalculator();
  initInterviewCalendar();
  initApplicationForm();
  initFaqAccordion();
  initPixelMonitorToggle();
});

// 1. Reproductor de Video Invitación Real (Agente_Smart_VF.mp4)
function initVideoPlayer() {
  const videoStage = document.getElementById('recruitmentVideoStage');
  const videoEl = document.getElementById('recruitmentVideo');
  const playBtn = document.getElementById('videoPlayBtn');
  const miniPlayBtn = document.getElementById('videoMiniPlayBtn');
  const muteBtn = document.getElementById('videoMuteBtn');
  const fullscreenBtn = document.getElementById('videoFullscreenBtn');
  const progressTrack = document.getElementById('videoProgressTrack');
  const progressFill = document.getElementById('videoProgressFill');
  const timerLabel = document.getElementById('videoTimerLabel');
  const playHint = document.getElementById('videoPlayHint');

  if (!videoStage || !videoEl) return;

  let trackedStart = false;
  let trackedHalf = false;

  const formatTime = (seconds) => {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const syncButtons = () => {
    const playing = !videoEl.paused && !videoEl.ended;
    videoStage.classList.toggle('is-playing', playing);
    if (playBtn) playBtn.innerHTML = playing ? '⏸' : (videoEl.ended ? '↻' : '▶');
    if (miniPlayBtn) miniPlayBtn.innerHTML = playing ? '⏸' : '▶';
    if (playHint) {
      playHint.textContent = playing
        ? 'Haz clic para pausar'
        : 'Haz clic para reproducir el video informativo';
    }
  };

  const togglePlay = () => {
    if (videoEl.paused || videoEl.ended) {
      videoEl.play().catch(() => {});
    } else {
      videoEl.pause();
    }
  };

  videoStage.addEventListener('click', togglePlay);
  if (miniPlayBtn) {
    miniPlayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlay();
    });
  }

  videoEl.addEventListener('loadedmetadata', () => {
    if (timerLabel) {
      timerLabel.textContent = `0:00 / ${formatTime(videoEl.duration)}`;
    }
  });

  videoEl.addEventListener('play', () => {
    syncButtons();
    if (!trackedStart) {
      trackedStart = true;
      trackMarketingEvent('ViewContent', {
        content_type: 'RecruitmentVideoInvitation',
        video_file: 'Agente_Smart_VF.mp4'
      });
    }
  });

  videoEl.addEventListener('pause', syncButtons);

  videoEl.addEventListener('timeupdate', () => {
    const duration = videoEl.duration || 0;
    const current = videoEl.currentTime || 0;
    const pct = duration > 0 ? (current / duration) * 100 : 0;

    if (progressFill) {
      progressFill.style.width = `${pct}%`;
    }
    if (timerLabel) {
      timerLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    }

    if (!trackedHalf && pct >= 50) {
      trackedHalf = true;
      trackMarketingEvent('VideoProgress50', {
        content_type: 'RecruitmentVideoInvitation',
        video_file: 'Agente_Smart_VF.mp4'
      });
    }
  });

  videoEl.addEventListener('ended', () => {
    syncButtons();
    trackMarketingEvent('VideoComplete', {
      content_type: 'RecruitmentVideoInvitation',
      video_file: 'Agente_Smart_VF.mp4'
    });
  });

  if (progressTrack) {
    progressTrack.style.cursor = 'pointer';
    progressTrack.addEventListener('click', (e) => {
      if (!videoEl.duration) return;
      const rect = progressTrack.getBoundingClientRect();
      const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      videoEl.currentTime = clickRatio * videoEl.duration;
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      videoEl.muted = !videoEl.muted;
      muteBtn.textContent = videoEl.muted ? '🔇' : '🔊';
    });
  }

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (videoEl.requestFullscreen) {
        videoEl.requestFullscreen();
      } else if (videoEl.webkitRequestFullscreen) {
        videoEl.webkitRequestFullscreen();
      }
    });
  }
}

// 2. Calculadora Interactiva de Ingresos (Sueldo Base + Comisiones Semanales)
function initEarningsCalculator() {
  const slider = document.getElementById('weeklyCommissionSlider');
  const weeklyLabel = document.getElementById('weeklyCommissionVal');
  const monthlyCommissionLabel = document.getElementById('monthlyCommissionVal');
  const monthlyTotalLabel = document.getElementById('monthlyTotalVal');
  let trackedCalc = false;

  if (!slider) return;

  const updateNumbers = () => {
    const weeklyComm = parseInt(slider.value, 10);
    const monthlyComm = weeklyComm * 4;
    const baseMonthly = 6000; // $3,000 libres quincenales x 2
    const totalMonthly = baseMonthly + monthlyComm;

    weeklyLabel.textContent = `$${weeklyComm.toLocaleString('es-MX')} MXN / viernes`;
    monthlyCommissionLabel.textContent = `$${monthlyComm.toLocaleString('es-MX')} MXN`;
    monthlyTotalLabel.textContent = `$${totalMonthly.toLocaleString('es-MX')} MXN libres/mes`;

    if (!trackedCalc) {
      trackedCalc = true;
      trackMarketingEvent('CustomizeProduct', { interaction: 'SalaryCalculatorUsed', weekly_commission_estimate: weeklyComm });
    }
  };

  slider.addEventListener('input', updateNumbers);
}

// 3. Generador Dinámico de Fechas Hábiles para Entrevista
function initInterviewCalendar() {
  const dateContainer = document.getElementById('interviewDateSlots');
  const timeContainer = document.getElementById('interviewTimeSlots');
  const hiddenDateInput = document.getElementById('selectedInterviewDate');
  const hiddenTimeInput = document.getElementById('selectedInterviewTime');

  if (!dateContainer || !timeContainer) return;

  const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  const upcomingDays = [];
  const cursor = new Date();

  while (upcomingDays.length < 4) {
    cursor.setDate(cursor.getDate() + 1);
    const dayOfWeek = cursor.getDay();
    // Lunes a Viernes
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const formatted = `${dayNames[dayOfWeek]} ${cursor.getDate()} ${monthNames[cursor.getMonth()]}`;
      upcomingDays.push(formatted);
    }
  }

  dateContainer.innerHTML = '';
  upcomingDays.forEach((label, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `slot-btn ${idx === 0 ? 'selected' : ''}`;
    btn.textContent = label;
    if (idx === 0) hiddenDateInput.value = label;

    btn.addEventListener('click', () => {
      dateContainer.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      hiddenDateInput.value = label;
    });
    dateContainer.appendChild(btn);
  });

  timeContainer.querySelectorAll('.slot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      timeContainer.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      hiddenTimeInput.value = btn.dataset.time;
    });
  });
}

// 4. Formulario de Pre-Filtro y Generación de Pase de Entrevista
function initApplicationForm() {
  const form = document.getElementById('recruitmentFilterForm');
  const nameInput = document.getElementById('candidateName');
  let startedForm = false;

  if (!form) return;

  nameInput.addEventListener('focus', () => {
    if (!startedForm) {
      startedForm = true;
      trackMarketingEvent('InitiateCheckout', { step: 'FormStarted' });
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const fullName = document.getElementById('candidateName').value.trim();
    const age = parseInt(document.getElementById('candidateAge').value, 10);
    const phone = document.getElementById('candidatePhone').value.trim();
    const municipality = document.getElementById('candidateMunicipality').value;
    const preferredShift = document.getElementById('candidateShift').value;
    const experience = document.getElementById('candidateExperience').value;

    const pcSkill = form.querySelector('input[name="pcSkill"]:checked')?.value;
    const locationOk = form.querySelector('input[name="locationOk"]:checked')?.value;
    const docsOk = form.querySelector('input[name="docsOk"]:checked')?.value;
    const salesOk = form.querySelector('input[name="salesOk"]:checked')?.value;

    const interviewDate = document.getElementById('selectedInterviewDate').value;
    const interviewTime = document.getElementById('selectedInterviewTime').value;

    // Validación de filtros indispensables (según PDF páginas 2, 3, 4, 6 y 7)
    const reasons = [];
    if (isNaN(age) || age < 17) {
      reasons.push('La vacante requiere tener 18 años en adelante (o 17 años cumplidos si estás estudiando).');
    }
    if (pcSkill !== 'si') {
      reasons.push('El manejo básico-intermedio de computadora es indispensable para utilizar el sistema de chat y llamadas.');
    }
    if (locationOk !== 'si') {
      reasons.push('La modalidad es 100% presencial en el Centro de Monterrey (frente a Plaza La Purísima).');
    }
    if (docsOk !== 'si') {
      reasons.push('Para ingresar los días jueves es requisito contar con tu papelería completa (sin documentos pendientes o en trámite).');
    }
    if (salesOk !== 'si') {
      reasons.push('El puesto está enfocado en cierre de ventas por objetivos en llamada y chat con sueldo base + comisiones.');
    }

    const passBox = document.getElementById('interviewPassResult');
    const rejectBox = document.getElementById('filterRejectResult');

    if (reasons.length > 0) {
      // No cumple requisitos: NO disparamos evento Lead ni Schedule para cuidar la optimización del Pixel
      trackMarketingEvent('FilterDisqualified', { reasons_count: reasons.length });
      passBox.style.display = 'none';
      rejectBox.style.display = 'block';
      const listEl = document.getElementById('rejectReasonsList');
      listEl.innerHTML = reasons.map(r => `<li>• ${r}</li>`).join('');
      rejectBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // Candidato Calificado: Disparamos Lead + Schedule a Meta Pixel y Google Ads
    rejectBox.style.display = 'none';
    const folio = `369-${Math.floor(1000 + Math.random() * 9000)}`;

    trackMarketingEvent('Lead', {
      content_name: PIXEL_CONFIG.VACANCY_TITLE,
      shift: preferredShift,
      municipality: municipality,
      has_experience: experience,
      value: 150.0,
      currency: 'MXN'
    });

    trackMarketingEvent('Schedule', {
      interview_date: interviewDate,
      interview_time: interviewTime,
      folio: folio,
      value: 300.0,
      currency: 'MXN'
    });

    // Rellenar Pase de Entrevista Digital
    document.getElementById('passFolio').textContent = folio;
    document.getElementById('passCandidateName').textContent = `${fullName} (${age} años)`;
    document.getElementById('passShift').textContent = preferredShift;
    document.getElementById('passDateTime').textContent = `${interviewDate} a las ${interviewTime}`;
    document.getElementById('passMunicipality').textContent = municipality;

    // Construir enlace directo a WhatsApp con todas las respuestas pre-filtradas
    const waMessage = [
      `Hola *Capital Humano 369* (Atención: *Hilaria Escobar*), aprobé el filtro en la landing de la vacante *Agente Smart (Sector Telecomunicaciones)* y agendé mi entrevista:`,
      ``,
      `🎟 *Folio Pase:* ${folio}`,
      `👤 *Nombre:* ${fullName} (${age} años)`,
      `📍 *Municipio:* ${municipality}`,
      `⏰ *Turno elegido:* ${preferredShift}`,
      `📅 *Cita de entrevista:* ${interviewDate} - ${interviewTime}`,
      `💻 *Manejo de PC y papelería completa:* Sí`,
      `💼 *Experiencia previa:* ${experience}`,
      `✅ *De acuerdo con funciones (llamada/chat) y esquema ($3,000 libres quincenales + comisiones):* Sí`,
      `📊 *Origen:* ${ATTRIBUTION.utm_source} (${ATTRIBUTION.utm_campaign})`
    ].join('\n');

    const waUrl = `https://wa.me/${PIXEL_CONFIG.WHATSAPP_RECRUITER}?text=${encodeURIComponent(waMessage)}`;
    const waBtn = document.getElementById('confirmWhatsAppBtn');
    waBtn.href = waUrl;

    passBox.style.display = 'block';
    passBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// 5. Acordeón de Preguntas Frecuentes
function initFaqAccordion() {
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      item.classList.toggle('open');
    });
  });
}

// 6. Toggle del Monitor de Píxeles (Modo Demo)
function initPixelMonitorToggle() {
  const header = document.getElementById('pixelDebuggerHeader');
  const body = document.getElementById('pixelDebuggerBody');
  const toggleIcon = document.getElementById('pixelToggleIcon');

  if (!header || !body) return;

  header.addEventListener('click', () => {
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    toggleIcon.textContent = isHidden ? '▾' : '▴';
  });
}
