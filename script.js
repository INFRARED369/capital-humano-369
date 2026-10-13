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
