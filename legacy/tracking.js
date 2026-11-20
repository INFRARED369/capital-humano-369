(() => {
  const config = window.CH369_TRACKING || {};
  const has = (value) => typeof value === 'string' && value.trim().length > 0;

  const loadScript = (src, id) => {
    if (document.getElementById(id)) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = src;
    script.id = id;
    document.head.appendChild(script);
  };

  const track = (eventName, params = {}) => {
    if (typeof window.gtag === 'function') window.gtag('event', eventName, params);
    if (typeof window.fbq === 'function') window.fbq('trackCustom', eventName, params);
  };

  // Google Tag Manager: remains off while gtmId is empty.
  if (has(config.gtmId)) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    loadScript(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(config.gtmId)}`, 'ch369-gtm');
  }

  // Google Analytics 4: remains off while ga4MeasurementId is empty.
  if (has(config.ga4MeasurementId)) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', config.ga4MeasurementId, { anonymize_ip: true });
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.ga4MeasurementId)}`, 'ch369-ga4');
  }

  // Meta Pixel: remains off while metaPixelId is empty.
  if (has(config.metaPixelId)) {
    window.fbq = window.fbq || function () {
      window.fbq.callMethod ? window.fbq.callMethod.apply(window.fbq, arguments) : window.fbq.queue.push(arguments);
    };
    window.fbq.push = window.fbq;
    window.fbq.loaded = true;
    window.fbq.version = '2.0';
    window.fbq.queue = [];
    window.fbq('init', config.metaPixelId);
    window.fbq('track', 'PageView');
    loadScript('https://connect.facebook.net/en_US/fbevents.js', 'ch369-meta-pixel');
  }

  document.querySelectorAll('a[href="#contacto"]').forEach((link) => {
    link.addEventListener('click', () => track('lead_cta_click', { link_text: link.textContent.trim() }));
  });

  document.querySelectorAll('a[href^="mailto:"]').forEach((link) => {
    link.addEventListener('click', () => track('contact_email_click'));
  });

  document.querySelector('#lead-form')?.addEventListener('submit', () => {
    track('lead_form_submit', { form_id: 'lead-form' });
  });
})();
