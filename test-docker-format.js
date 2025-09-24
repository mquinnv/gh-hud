#!/usr/bin/env bun

// Simple test to show what the Docker panel will look like

const services = [
  { name: "db", state: "running", health: "healthy" },
  { name: "gql", state: "running", health: "healthy" },
  { name: "nginx", state: "running", health: "unhealthy" },
  { name: "ui", state: "running", health: "starting" },
  { name: "redis", state: "exited", health: "none" },
  { name: "worker", state: "running", health: "none" },
];

console.log("Docker panel format preview:\n");
console.log("=" .repeat(50));
console.log("Docker:");

// Format services
const formatted = services.map(s => {
  let icon = "";
  let color = "";
  
  if (s.state === "running") {
    if (s.health === "healthy") {
      icon = "✓";
      color = "\x1b[32m"; // green
    } else if (s.health === "unhealthy") {
      icon = "✗";
      color = "\x1b[31m"; // red
    } else if (s.health === "starting") {
      icon = "◐";
      color = "\x1b[33m"; // yellow
    } else {
      icon = "●";
      color = "\x1b[32m"; // green
    }
  } else if (s.state === "exited") {
    icon = "○";
    color = "\x1b[90m"; // gray
  }
  
  return `${color}${icon}\x1b[0m ${s.name}`;
});

console.log("  [clean] " + formatted.slice(0, 4).join("  "));
console.log("  [other] " + formatted.slice(4).join("  "));
console.log("=" .repeat(50));

console.log("\nThis shows multiple services on one line with just icon + name");
console.log("Much more compact than showing status text, health labels, and ports!");