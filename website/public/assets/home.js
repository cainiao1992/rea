function initializePercentDemo() {
  const demo = document.querySelector("[data-percent-demo]");
  if (demo === null) return;
  const display = demo.querySelector("[data-percent-display]");
  const expression = demo.querySelector("[data-percent-expression]");
  const status = demo.querySelector("[data-percent-status]");
  const equals = demo.querySelector('[data-percent-key="equals"]');
  const operations = demo.querySelectorAll("[data-percent-operation]");
  let operation = "add";
  let stage = "input";

  const render = () => {
    const adding = operation === "add";
    const percent = adding ? 20 : 0.1;
    const result = adding ? 220 : 20;
    const operator = adding ? "+" : "×";
    expression.textContent =
      stage === "result" ? `200 ${operator} ${percent} =` : `200 ${operator}`;
    display.textContent = String(
      stage === "input" ? 10 : stage === "percent" ? percent : result,
    );
    equals.disabled = stage !== "percent";
    status.textContent =
      stage === "input"
        ? "Press % to see what happens to 10."
        : stage === "percent"
          ? adding
            ? "10% of 200 is 20. Press = to add it."
            : "For multiplication, 10 becomes 0.1. Press = to multiply."
          : `200 ${operator} ${percent} = ${result}.`;
  };

  operations.forEach((button) => {
    button.addEventListener("click", () => {
      operation = button.getAttribute("data-percent-operation");
      stage = "input";
      operations.forEach((candidate) => {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      });
      render();
    });
  });
  demo.querySelectorAll("[data-percent-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-percent-key");
      stage =
        key === "reset" ? "input" : key === "percent" ? "percent" : "result";
      render();
    });
  });
  demo.querySelector(".percent-operation").hidden = false;
  demo.querySelector(".percent-controls").hidden = false;
  render();
}

initializePercentDemo();
