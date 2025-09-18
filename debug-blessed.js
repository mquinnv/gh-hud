#!/usr/bin/env node

import blessed from "blessed"

console.log("Creating blessed screen...")

const screen = blessed.screen({
  smartCSR: true,
  title: "Debug Test",
  fullUnicode: true,
  autoPadding: true,
  warnings: false,
})

console.log("Screen created, setting up...")

const box = blessed.box({
  parent: screen,
  top: "center",
  left: "center",
  width: "50%",
  height: "50%",
  content: "Hello! Press q to quit.",
  tags: true,
  border: {
    type: "line",
  },
  style: {
    fg: "white",
    border: {
      fg: "cyan",
    },
  },
})

screen.key(["q", "C-c"], () => {
  console.log("Exiting...")
  process.exit(0)
})

console.log("Rendering screen...")
screen.render()

console.log("Screen should be visible now")
