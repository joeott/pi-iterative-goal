const links = [...document.querySelectorAll(".nav a")];
const sections = links
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

const observer = new IntersectionObserver((entries) => {
  const visible = entries
    .filter((entry) => entry.isIntersecting)
    .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  links.forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`);
  });
}, { rootMargin: "-20% 0px -65% 0px", threshold: [0.1, 0.25, 0.5] });

sections.forEach((section) => observer.observe(section));

for (const table of document.querySelectorAll("table")) {
  const wrap = table.closest(".table-wrap");
  if (!wrap) continue;
  wrap.setAttribute("tabindex", "0");
  wrap.setAttribute("aria-label", "Scrollable reference table");
}
