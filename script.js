const menuToggle = document.querySelector('.menu-toggle');
const mainNav = document.querySelector('.main-nav');

menuToggle?.addEventListener('click', () => {
  const isOpen = mainNav.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(isOpen));
  menuToggle.setAttribute('aria-label', isOpen ? 'Cerrar menú' : 'Abrir menú');
});

document.querySelectorAll('.main-nav a').forEach((link) => {
  link.addEventListener('click', () => {
    mainNav.classList.remove('open');
    menuToggle?.setAttribute('aria-expanded', 'false');
  });
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in-view');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

const sectorTabs = document.querySelectorAll('.sector-tab');
const sectorContents = document.querySelectorAll('.sector-content');
sectorTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const selected = tab.dataset.sector;
    sectorTabs.forEach((item) => item.classList.toggle('active', item === tab));
    sectorContents.forEach((content) => content.classList.toggle('active', content.dataset.content === selected));
  });
});

const form = document.querySelector('#lead-form');
const success = document.querySelector('.form-success');
form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.innerHTML = 'Enviado <span>✓</span>';
  success.classList.add('visible');
  form.reset();
  window.setTimeout(() => {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Solicitar diagnóstico <span>↗</span>';
  }, 5000);
});

const header = document.querySelector('.site-header');
window.addEventListener('scroll', () => {
  header?.classList.toggle('scrolled', window.scrollY > 45);
}, { passive: true });

// Sector addition: Tecnología y TI
(() => {
  const selector = document.querySelector('.sector-selector');
  const display = document.querySelector('.sector-display');
  if (!selector || !display || selector.querySelector('[data-sector="ti"]')) return;
  const tab = document.createElement('button');
  tab.className = 'sector-tab';
  tab.dataset.sector = 'ti';
  tab.innerHTML = '<span>06</span> Tecnología y TI <b>↗</b>';
  selector.appendChild(tab);
  const content = document.createElement('div');
  content.className = 'sector-content';
  content.dataset.content = 'ti';
  content.innerHTML = '<h3>Tecnología<br /><em>y TI.</em></h3><p>Desarrollo, soporte, infraestructura, datos, ciberseguridad y liderazgo técnico.</p>';
  display.insertBefore(content, display.querySelector('.display-grid-lines'));
  tab.addEventListener('click', () => {
    selector.querySelectorAll('.sector-tab').forEach((item) => item.classList.toggle('active', item === tab));
    display.querySelectorAll('.sector-content').forEach((item) => item.classList.toggle('active', item === content));
  });
})();

// Portada: acceso visual a Tecnología y TI
(() => {
  const services = document.querySelector('.mockup-services');
  if (!services || services.querySelector('[data-home-sector="ti"]')) return;
  if (window.innerWidth > 1050) services.style.setProperty('grid-template-columns', 'repeat(10, minmax(0, 1fr))', 'important');
  const item = document.createElement('a');
  item.href = '#sectores';
  item.dataset.homeSector = 'ti';
  item.innerHTML = '<span class="service-icon">⌘</span><strong>Tecnología<br />y TI</strong>';
  services.appendChild(item);
})();
