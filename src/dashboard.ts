import blessed from "blessed";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DockerServiceStatus, PullRequest, WorkflowJob, WorkflowRun } from "./types.js"

export class Dashboard {
  private screen: blessed.Widgets.Screen;
  private grid: blessed.Widgets.BoxElement[] = [];
  private statusBox: blessed.Widgets.BoxElement;
  private debugBox: blessed.Widgets.BoxElement;
  private prHeaderBox?: blessed.Widgets.BoxElement;
  private dockerHeaderBox?: blessed.Widgets.BoxElement;
  private helpBox?: blessed.Widgets.BoxElement;
  private confirmBox?: blessed.Widgets.BoxElement;
  private selectedIndex = 0;
  private selectedPRIndex = 0;
  private selectedDockerIndex = 0;
  private flatDockerServices: Array<{service: {name: string, state: string, health?: string}, repo: string}> = [];
  private selectionMode: "workflows" | "prs" | "docker" = "workflows"; // Track which area is selected
  private workflows: WorkflowRun[] = [];
  private pullRequests: PullRequest[] = [];
  private dockerServices: DockerServiceStatus[] = [];
  private jobsCache = new Map<string, WorkflowJob[]>(); // Cache for job data
  private modalOpen = false;
  private currentBoxWidth = 80;
  private cols = 1; // Number of columns in the grid
  private rows = 1; // Number of rows in the grid
  private showPRs = false;
  private showDocker = false;
  private showDebug = false; // Hidden by default, press F9 to show
  private autoShowDebug = false; // Whether to show debug log on startup
  private logLevel: "info" | "debug" | "trace" = "info"; // Filter level for event log
  private logMessages: Array<{
    message: string;
    type: string;
    timestamp: string;
    formatted: string;
  }> = [];
  private maxLogMessages = 100; // Keep last 100 messages
  private debugBoxHeight = 5; // Default height, can be resized
  private minDebugHeight = 3;
  private maxDebugHeight = 15;
  private layoutInProgress = false;
  private uiUpdateInProgress = false;
  private keyEventQueue: Array<() => void> = [];
  private pendingPrefsLog: string[] = []; // Store preference log messages until UI is ready
  private debugUpdateTimer?: NodeJS.Timeout; // Timer for batched debug box updates
  private refreshAnimationTimer?: NodeJS.Timeout; // Timer for refresh animation
  private refreshAnimationFrame = 0; // Current frame of refresh animation
  private lastRefreshTime?: Date; // Track when data was actually refreshed
  private lastStatusLine1 = ""; // Cache last status line to avoid re-rendering
  private lastStatusLine2 = ""; // Cache last status line to avoid re-rendering

  constructor() {
    // Load saved preferences
    this.loadPreferences();

    // Disable mouse tracking completely
    if (process.stdout.isTTY) {
      // Disable mouse reporting sequences
      process.stdout.write("\x1b[?1000l"); // Disable X10 mouse
      process.stdout.write("\x1b[?1002l"); // Disable button event mouse
      process.stdout.write("\x1b[?1003l"); // Disable any-event mouse
      process.stdout.write("\x1b[?1006l"); // Disable SGR mouse
    }

    // Override TERM environment variable to force a simpler terminal
    const originalTerm = process.env.TERM;
    process.env.TERM = "xterm-color"; // Use xterm-color which doesn't have Setulc

    this.screen = blessed.screen({
      smartCSR: true,
      title: "GitHub Workflow Monitor",
      fullUnicode: true,
      warnings: false,
      keys: true,
      vi: false,
      mouse: false, // Explicitly disable mouse support
      input: process.stdin,
      output: process.stdout,
      terminal: "xterm-color", // Force xterm-color to avoid Setulc
      forceUnicode: true,
      fastCSR: true, // Use fast CSR to reduce flickering
      useBCE: false, // Don't use background color erase which can cause flicker
      autoPadding: false, // Disable auto padding which can cause redraws
      ignoreDockContrast: true, // Avoid special terminal handling
      dockContrast: false, // Disable dock contrast which may trigger Setulc
    });

    // Restore original TERM after screen creation
    if (originalTerm) {
      process.env.TERM = originalTerm;
    }

    // Create debug/log box (sits above status bar when shown)
    this.debugBox = blessed.box({
      bottom: 3,
      left: 0,
      width: "100%",
      height: this.debugBoxHeight,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "cyan",
        // bg removed - inherit terminal background
        border: {
          fg: "#444444",
        },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        track: {
          bg: "cyan",
        },
        style: {
          inverse: true,
        },
      },
      keys: true,
      vi: false, // Disable vi mode to prevent ESC from closing
      label: " Event Log (F9 to toggle) ",
      hidden: !this.showDebug,
    });

    // Create status bar at the bottom (2 lines of content + border)
    this.statusBox = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        // bg removed - inherit terminal background
        border: {
          fg: "#f0f0f0",
        },
      },
    });

    this.screen.append(this.debugBox);
    this.screen.append(this.statusBox);

    // Create help box (hidden initially)
    this.createHelpBox();

    // Set up key bindings
    this.setupKeyBindings();

    // Manual key handling as fallback for problematic keys
    this.screen.on("keypress", (_ch, key) => {
      if (!key) return;

      // Ignore ESC key presses
      if (key.name === "escape") {
        return; // Prevent any default handling
      }

      // Manual key handling for uppercase D as fallback
      if (key.name === "d" && key.shift && !key.ctrl && !key.meta) {
        const completedWorkflows = this.workflows.filter(
          (w) => w.status === "completed",
        );
        if (completedWorkflows.length > 0) {
          this.screen.emit("dismiss-all-completed", completedWorkflows);
        }
        return; // Prevent further processing
      }

      // Handle lowercase d manually as additional backup
      if (key.name === "d" && !key.shift && !key.ctrl && !key.meta) {
        const workflow = this.workflows[this.selectedIndex];
        if (workflow && workflow.status === "completed") {
          this.screen.emit("dismiss-workflow", workflow);
        }
      }
    });

    // Handle resize
    this.screen.on("resize", () => {
      this.layoutWorkflows();
    });

    // Show initial status (no loading dialog)
    this.showInitialState();

    // Ensure screen can receive key events and render
    this.screen.render();

    // Make sure we're listening for the right key events
    this.screen.program.input.setEncoding("utf8");
    this.screen.program.input.resume();

    // Force the screen to grab keys and focus
    this.screen.enableKeys();

    // Hide cursor
    if (this.screen.program) {
      this.screen.program.hideCursor();

      // Remove Setulc capability entirely from terminfo
      const program = this.screen.program as any;
      if (program.terminfo) {
        delete program.terminfo.Setulc;
        delete program.terminfo.setulc;
      }
      if (program.terminal) {
        delete program.terminal.Setulc;
        delete program.terminal.setulc;
      }
      // Also remove from the blessed tput if it exists
      if (program.tput) {
        delete program.tput.Setulc;
        delete program.tput.setulc;
      }

      // Wrap ALL program methods to catch terminal errors
      // Wrap the _write method which is what actually outputs
      const original_write =
        program._write?.bind(program) || program.write?.bind(program);
      if (original_write) {
        program._write = (text: string) => {
          try {
            return original_write(text);
          } catch (error: unknown) {
            // Silently ignore ALL terminal capability errors
            const errorMessage = error instanceof Error ? error.message : String(error);
            process.stderr.write(
              `\nIgnoring terminal error: ${errorMessage?.substring(0, 50)}\n`,
            );
            return true;
          }
        };
      }

      // Also wrap the main write method
      const originalWrite = program.write?.bind(program);
      if (originalWrite) {
        program.write = (text: string) => {
          try {
            return originalWrite(text);
          } catch (error: unknown) {
            // Silently ignore terminal capability errors
            const errorMessage = error instanceof Error ? error.message : String(error);
            process.stderr.write(
              `\nIgnoring write error: ${errorMessage?.substring(0, 50)}\n`,
            );
            return true;
          }
        };
      }
    }
  }

  private setupKeyBindings(): void {
    // Make sure the screen is focused and can receive key events
    // Note: blessed screens don't have a focus() method

    // Handle quit commands with proper cleanup
    this.screen.key(["q", "C-c"], () => {
      this.cleanup();
    });

    // Handle manual refresh
    this.screen.key(["r"], () => {
      this.screen.emit("manual-refresh");
    });

    // 2D Grid Navigation keys (vim-style) with seamless Docker/PR/workflow navigation
    this.screen.key(["up", "k", "C-p"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "workflows") {
          // If on top row of workflows, move to PRs or Docker
          const currentCoords = this.indexToCoords(this.selectedIndex);
          if (currentCoords.row === 0) {
            if (this.showPRs && this.pullRequests.length > 0) {
              this.selectionMode = "prs";
              // Select rightmost PR if coming from right column
              if (this.cols > 1 && currentCoords.col > 0) {
                this.selectedPRIndex = Math.min(currentCoords.col, this.pullRequests.length - 1);
              }
              this.updatePRHighlight();
              this.highlightSelected();
            } else if (this.showDocker && this.flatDockerServices.length > 0) {
              this.selectionMode = "docker";
              this.updateDockerHighlight();
              this.highlightSelected();
            }
          } else {
            this.navigateGrid("up");
          }
        } else if (this.selectionMode === "prs") {
          // From PRs, go up to Docker if it exists
          if (this.showDocker && this.flatDockerServices.length > 0) {
            this.selectionMode = "docker";
            this.updateDockerHighlight();
            this.updatePRHighlight();
          } else {
            // Navigate within PRs
            this.navigatePRs("left");
          }
        } else if (this.selectionMode === "docker") {
          // Navigate within Docker services
          this.navigateDocker("left");
        }
      });
    });

    this.screen.key(["down", "j", "C-n"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "docker") {
          // Moving down from Docker goes to PRs or workflows
          if (this.showPRs && this.pullRequests.length > 0) {
            this.selectionMode = "prs";
            this.updateDockerHighlight();
            this.updatePRHighlight();
          } else {
            this.selectionMode = "workflows";
            this.selectedIndex = 0;
            this.updateDockerHighlight();
            this.highlightSelected();
          }
        } else if (this.selectionMode === "prs") {
          // Moving down from PRs goes to workflows
          this.selectionMode = "workflows";
          // Try to position in the same column if possible
          const targetCol = Math.min(this.selectedPRIndex, this.cols - 1);
          const targetIndex = Math.min(targetCol, this.workflows.length - 1);
          this.selectedIndex = targetIndex;
          this.updatePRHighlight();
          this.highlightSelected();
        } else if (this.selectionMode === "workflows") {
          this.navigateGrid("down");
        }
      });
    });

    // Left/right navigation (vim-style)
    this.screen.key(["left", "h"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "workflows") {
          this.navigateGrid("left");
        } else if (this.selectionMode === "prs") {
          this.navigatePRs("left");
        } else if (this.selectionMode === "docker") {
          this.navigateDocker("left");
        }
      });
    });

    this.screen.key(["right", "l"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "workflows") {
          this.navigateGrid("right");
        } else if (this.selectionMode === "prs") {
          this.navigatePRs("right");
        } else if (this.selectionMode === "docker") {
          this.navigateDocker("right");
        }
      });
    });

    // Open workflow/PR in browser or restart Docker service
    this.screen.key(["enter"], () => {
      if (this.selectionMode === "workflows") {
        const workflow = this.workflows[this.selectedIndex];
        if (workflow) {
          this.screen.emit("open-workflow", workflow);
        }
      } else if (this.selectionMode === "prs" && this.showPRs) {
        const pr = this.pullRequests[this.selectedPRIndex];
        if (pr) {
          this.screen.emit("open-pr", pr);
        }
      } else if (this.selectionMode === "docker" && this.showDocker) {
        const dockerService = this.flatDockerServices[this.selectedDockerIndex];
        if (dockerService) {
          this.screen.emit("restart-docker", dockerService);
        }
      }
    });

    // Dismiss completed workflow
    this.screen.key(["d"], () => {
      const workflow = this.workflows[this.selectedIndex];
      if (workflow && workflow.status === "completed") {
        this.screen.emit("dismiss-workflow", workflow);
      }
    });

    // Kill/cancel running workflow
    this.screen.key(["k"], () => {
      const workflow = this.workflows[this.selectedIndex];
      if (workflow && (workflow.status === "in_progress" || workflow.status === "queued")) {
        this.showKillConfirmation(workflow);
      }
    });

    // Dismiss ALL completed workflows - comprehensive key handling
    const dismissAllHandler = () => {
      const completedWorkflows = this.workflows.filter(
        (w) => w.status === "completed",
      );
      if (completedWorkflows.length > 0) {
        this.screen.emit("dismiss-all-completed", completedWorkflows);
      }
    };

    // Try multiple key binding approaches
    this.screen.key(["D"], dismissAllHandler);
    this.screen.key(["S-d"], dismissAllHandler);
    this.screen.key(["shift+d"], dismissAllHandler);

    // Show help - don't use queue, just show directly
    this.screen.key(["?", "/"], () => {
      // Removed debug output
      this.showHelp();
    });

    // Toggle debug panel - F9 only, no F12 to avoid conflicts
    this.screen.key(["f9"], () => {
      this.queueKeyEvent(() => this.toggleDebug());
    });

    // Toggle log level (F10)
    this.screen.key(["f10"], () => {
      this.queueKeyEvent(() => this.toggleLogLevel());
    });

    // Toggle auto-show on startup (a for auto-show)
    this.screen.key(["a", "A"], () => {
      this.queueKeyEvent(() => this.toggleAutoShowDebug());
    });

    // Resize debug panel (when visible) - vim-style
    this.screen.key(["C-k"], () => {
      this.queueKeyEvent(() => {
        if (this.showDebug) {
          this.resizeDebugBox(1); // Increase height (up = more lines)
        }
      });
    });

    // Ctrl+j might be interpreted as newline in some terminals, so we need multiple bindings
    const decreaseDebugHandler = () => {
      this.queueKeyEvent(() => {
        if (this.showDebug) {
          this.resizeDebugBox(-1); // Decrease height (down = fewer lines)
        }
      });
    };

    this.screen.key(["C-j"], decreaseDebugHandler);
    this.screen.key(["ctrl+j"], decreaseDebugHandler);
    // Alternative keys for decreasing debug box size
    this.screen.key(["C-d"], decreaseDebugHandler);
    this.screen.key(["M-j"], decreaseDebugHandler); // Alt+j as alternative

    // Also handle process signals for clean shutdown
    process.on("SIGINT", () => {
      this.log("Received SIGINT, saving preferences...", "info");
      this.cleanup();
    });
    process.on("SIGTERM", () => {
      this.log("Received SIGTERM, saving preferences...", "info");
      this.cleanup();
    });
    // Handle uncaught exits
    process.on("beforeExit", () => {
      this.log("Process exiting, saving preferences...", "info");
      this.savePreferences();
    });
  }

  // Convert linear array index to 2D grid coordinates
  private indexToCoords(index: number): { row: number; col: number } {
    // Ensure cols is at least 1 to avoid division by zero
    const cols = Math.max(1, this.cols);
    return {
      row: Math.floor(index / cols),
      col: index % cols,
    };
  }

  // Convert 2D grid coordinates to linear array index
  private coordsToIndex(row: number, col: number): number {
    return row * this.cols + col;
  }

  // Check if a grid position is valid (within bounds and has a workflow)
  private isValidGridPosition(row: number, col: number): boolean {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      return false;
    }
    const index = this.coordsToIndex(row, col);
    return index >= 0 && index < this.workflows.length;
  }


  // Navigate PRs
  private navigatePRs(direction: "up" | "down" | "left" | "right"): void {
    if (this.pullRequests.length === 0) return;
    
    const currentIndex = this.selectedPRIndex;
    let newIndex = currentIndex;
    
    switch (direction) {
      case "left":
      case "up":
        newIndex = currentIndex - 1;
        if (newIndex < 0) {
          newIndex = this.pullRequests.length - 1; // Wrap to end
        }
        break;
      case "right":
      case "down":
        newIndex = currentIndex + 1;
        if (newIndex >= this.pullRequests.length) {
          newIndex = 0; // Wrap to beginning
        }
        break;
    }
    
    if (newIndex !== currentIndex) {
      this.selectedPRIndex = newIndex;
      this.updatePRHighlight();
    }
  }

  // Navigate Docker services
  private navigateDocker(direction: "up" | "down" | "left" | "right"): void {
    if (this.flatDockerServices.length === 0) return;
    
    const currentIndex = this.selectedDockerIndex;
    let newIndex = currentIndex;
    
    switch (direction) {
      case "left":
      case "up":
        newIndex = currentIndex - 1;
        if (newIndex < 0) {
          newIndex = this.flatDockerServices.length - 1; // Wrap to end
        }
        break;
      case "right":
      case "down":
        newIndex = currentIndex + 1;
        if (newIndex >= this.flatDockerServices.length) {
          newIndex = 0; // Wrap to beginning
        }
        break;
    }
    
    if (newIndex !== currentIndex) {
      this.selectedDockerIndex = newIndex;
      this.updateDockerHighlight();
    }
  }

  // Update PR header to show selection
  private updatePRHighlight(): void {
    if (!this.prHeaderBox) return;
    
    // Re-render PR content with selection highlight
    const prContent = this.formatPRHeader(this.pullRequests);
    this.prHeaderBox.setContent(prContent);
    
    // Update border color based on selection mode
    if (this.prHeaderBox.style?.border) {
      this.prHeaderBox.style.border.fg = this.selectionMode === "prs" ? "cyan" : "#666666";
    }
    
    this.scheduleRender();
  }

  // Update Docker header to show selection
  private updateDockerHighlight(): void {
    if (!this.dockerHeaderBox) return;
    
    // Re-render Docker content with selection highlight
    const dockerContent = this.formatDockerHeader(this.dockerServices);
    this.dockerHeaderBox.setContent(dockerContent);
    
    // Update border color based on selection mode
    if (this.dockerHeaderBox.style?.border) {
      this.dockerHeaderBox.style.border.fg = this.selectionMode === "docker" ? "cyan" : "#888888";
    }
    
    this.scheduleRender();
  }

  // Navigate the 2D grid spatially
  private navigateGrid(direction: "up" | "down" | "left" | "right"): void {
    try {
      // Don't navigate if no workflows or grid not ready
      if (this.workflows.length === 0 || this.grid.length === 0) return;

      // Check if layout is somehow being triggered
      if (this.layoutInProgress) {
        return; // Don't navigate during layout
      }

      // Ensure cols and rows are initialized
      if (!this.cols || !this.rows) {
        this.cols = 1;
        this.rows = 1;
      }

      // Ensure selectedIndex is valid
      if (
        this.selectedIndex >= this.workflows.length ||
        this.selectedIndex < 0
      ) {
        this.selectedIndex = 0;
      }

      const currentCoords = this.indexToCoords(this.selectedIndex);
      let newRow = currentCoords.row;
      let newCol = currentCoords.col;

      switch (direction) {
        case "up":
          newRow = currentCoords.row - 1;
          // If at top row, don't wrap - stay in place
          // PR navigation is handled in the keybinding, not here
          if (newRow < 0) {
            return;
          }
          break;

        case "down":
          newRow = currentCoords.row + 1;
          // If at bottom row, don't wrap - stay in place
          if (newRow >= this.rows) {
            return;
          }
          break;

        case "left":
          // If only one column, can't move left
          if (this.cols <= 1) {
            return;
          }
          newCol = currentCoords.col - 1;
          // If at leftmost column, don't wrap - stay in place
          if (newCol < 0) {
            return;
          }
          break;

        case "right":
          // If only one column, can't move right
          if (this.cols <= 1) {
            return;
          }
          newCol = currentCoords.col + 1;
          // If at rightmost column, don't wrap - stay in place
          if (newCol >= this.cols) {
            return;
          }
          break;
      }

      // Check if the new position is valid (has a workflow)
      if (this.isValidGridPosition(newRow, newCol)) {
        const newIndex = this.coordsToIndex(newRow, newCol);
        if (newIndex < this.workflows.length) {
          this.selectedIndex = newIndex;
          this.highlightSelected();
        }
      }
      // If invalid position (like last row with fewer items), don't move
    } catch (error) {
      // Log the error but don't crash
      this.log(`Navigation error: ${error}`, "error");

      // Write to stderr so we can see it even if the UI crashes
      process.stderr.write(`\nNavigation error: ${error}\n`);
    }
  }

  private getBorderColor(workflow: WorkflowRun, isSelected: boolean): string {
    if (isSelected) return "cyan"; // Selected always gets cyan border

    if (workflow.status === "completed") {
      switch (workflow.conclusion) {
        case "success":
          return "green";
        case "failure":
          return "red";
        case "cancelled":
          return "red";
        case "skipped":
          return "gray";
        default:
          return "#f0f0f0";
      }
    }

    return "#f0f0f0"; // Default border for active workflows
  }

  private lastSelectedIndex = -1;

  private highlightSelected(): void {
    // Don't highlight if grid is not ready
    if (!this.grid || this.grid.length === 0) return;

    // Ensure selectedIndex is valid
    const maxIndex = Math.min(this.grid.length, this.workflows.length) - 1;
    if (this.selectedIndex > maxIndex) {
      this.selectedIndex = Math.max(0, maxIndex);
    }

    // Skip if selection hasn't changed and we're in workflow mode
    if (this.selectedIndex === this.lastSelectedIndex && this.selectionMode === "workflows") {
      return;
    }

  // Clear workflow selection if we're not in workflow mode
  if (this.selectionMode !== "workflows") {
    // Remove highlight from all workflow boxes
    this.grid.forEach((box, index) => {
      if (box?.style?.border) {
        const workflow = this.workflows[index];
        box.style.border.fg = workflow ? this.getBorderColor(workflow, false) : "#f0f0f0";
      }
    });
    this.lastSelectedIndex = -1;
    this.scheduleRender();
    return;
  }

    try {
      // Only update the two boxes that changed (old selected and new selected)
      if (
        this.lastSelectedIndex >= 0 &&
        this.lastSelectedIndex < this.grid.length
      ) {
        const oldBox = this.grid[this.lastSelectedIndex];
        if (oldBox?.style?.border) {
          const workflow = this.workflows[this.lastSelectedIndex];
          oldBox.style.border.fg = workflow
            ? this.getBorderColor(workflow, false)
            : "#f0f0f0";
        }

        // Update old box content to remove selected header styling
        const oldWorkflow = this.workflows[this.lastSelectedIndex];
        if (oldWorkflow) {
          const jobs = this.jobsCache.get(`${oldWorkflow.id}`) || [];
          const oldContent = this.formatWorkflowContent(
            oldWorkflow,
            jobs,
            false,
          );
          oldBox.setContent(oldContent);
        }
      }

      // Update new selected box
      if (this.selectedIndex >= 0 && this.selectedIndex < this.grid.length) {
        const newBox = this.grid[this.selectedIndex];
        if (newBox?.style?.border) {
          newBox.style.border.fg = "cyan";
        }

        // Update new box content to show selected header styling
        const newWorkflow = this.workflows[this.selectedIndex];
        if (newWorkflow) {
          const jobs = this.jobsCache.get(`${newWorkflow.id}`) || [];
          const newContent = this.formatWorkflowContent(
            newWorkflow,
            jobs,
            true,
          );
          newBox.setContent(newContent);
        }
      }

      this.lastSelectedIndex = this.selectedIndex;

      // Use batched render to avoid flickering
      this.scheduleRender();
    } catch (error) {
      this.log(`Error in highlightSelected: ${error}`, "error");
    }
  }

  // Removed screen click handler as it was causing issues with mouse hover

  private createHelpBox(): void {
    // Remove old help box if it exists
    if (this.helpBox) {
      this.helpBox.destroy();
    }

    this.helpBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "50%",
      height: "50%",
      content: `
{center}{bold}GitHub Workflow Monitor - Help{/bold}{/center}

{bold}Navigation:{/bold}
  Tab     - Switch between PRs and workflows
  ↑/k     - Move up in current area
  ↓/j     - Move down in current area
  ←/h     - Move left in current area
  →/l     - Move right in current area
  Enter   - Open selected item in browser

{bold}Actions:{/bold}
  r       - Force refresh
  d       - Dismiss completed workflow
  D       - Dismiss ALL completed workflows
  k       - Kill/cancel running workflow
  ?       - Show this help
  q/Ctrl+C - Quit

{bold}Options:{/bold}
  --show-prs - Show open PRs in header
  F9         - Toggle event log panel
  F10        - Cycle log level (info/debug/trace)
  a          - Toggle auto-show on startup
  Ctrl+k/d   - Resize event log (when visible)

{bold}Status Colors:{/bold}
  {yellow-fg}●{/} Running
  {green-fg}●{/} Success
  {red-fg}●{/} Failed
  {gray-fg}●{/} Queued

Press '?', '/', or 'Esc' to close...`,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "cyan",
        },
      },
      keys: true,
      hidden: true, // Start hidden
      focusable: false, // Don't steal focus when hidden
    });

    // Make sure help box is on top
    this.helpBox.setFront();

    // Set up help box key handlers once
    this.helpBox.key(["escape", "?", "/"], () => {
      this.hideHelp();
    });
  }

  private showHelp(): void {
    // Don't check isUpdating - we want help to always work

    // If already showing, hide it
    if (this.modalOpen && this.helpBox && !this.helpBox.hidden) {
      this.hideHelp();
      return;
    }

    // Make sure help box exists
    if (!this.helpBox) {
      this.createHelpBox();
    }

    this.modalOpen = true;
    if (this.helpBox) {
      this.helpBox.focusable = true; // Make focusable when showing
      this.helpBox.show();
      this.helpBox.setFront(); // Ensure it's on top
      this.helpBox.focus();

      // Force a render to show the help, catching any errors
      try {
        this.screen.render();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `\nHelp render error: ${errorMessage?.substring(0, 100)}\n`,
        );

        // Try to at least make it visible
        try {
          this.helpBox.setFront();
          this.screen.render();
        } catch (_e) {
          process.stderr.write(`\nCritical help render failure\n`);
        }
      }
    }
  }

  private hideHelp(): void {
    this.modalOpen = false;
    if (this.helpBox) {
      this.helpBox.hide();
      this.helpBox.focusable = false; // Make non-focusable when hidden

      // Try a safe render
      try {
        this.scheduleRender();
      } catch (_error: unknown) {
        // Ignore render errors when closing help
        process.stderr.write(`\nIgnoring help close render error\n`);
      }
    }
  }

  private showKillConfirmation(workflow: WorkflowRun): void {
    // Create confirmation dialog
    if (this.confirmBox) {
      this.confirmBox.destroy();
    }

    const projectName = `${workflow.repository.owner}/${workflow.repository.name}`;
    
    this.confirmBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: 60,
      height: 10,
      content: `{center}{bold}{red-fg}Cancel Workflow?{/red-fg}{/bold}{/center}

{center}${projectName}{/center}
{center}${workflow.workflowName || "Workflow"} Run #${workflow.runNumber}{/center}
{center}Branch: ${workflow.headBranch}{/center}

{center}{bold}Press 'y' to confirm, 'n' or ESC to cancel{/bold}{/center}`,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "red",
        },
      },
      keys: true,
    });

    this.modalOpen = true;
    this.confirmBox.show();
    this.confirmBox.setFront();
    this.confirmBox.focus();

    // Handle confirmation
    const confirmHandler = (_ch: any, key: any) => {
      if (key && (key.name === "y" || key.name === "Y")) {
        // User confirmed
        this.hideKillConfirmation();
        this.screen.emit("kill-workflow", workflow);
      } else if (key && (key.name === "n" || key.name === "N" || key.name === "escape")) {
        // User cancelled
        this.hideKillConfirmation();
      }
    };

    this.confirmBox.once("keypress", confirmHandler);
    
    this.screen.render();
  }

  private hideKillConfirmation(): void {
    this.modalOpen = false;
    if (this.confirmBox) {
      this.confirmBox.destroy();
      this.confirmBox = undefined;
    }
    this.scheduleRender();
  }

  private showInitialState(): void {
    // Just show the status bar with loading message - no intrusive dialog
    this.statusBox.setContent(
      "{center}Loading workflows... Press 'q' to quit{/center}",
    );
    this.log("GitHub HUD started", "info");

    // Log any pending preference messages
    if (this.pendingPrefsLog.length > 0) {
      this.pendingPrefsLog.forEach((msg) => {
        this.log(msg, "debug");
      });
      this.pendingPrefsLog = [];
    }

    this.log(
      "Press F9 to toggle event log, Ctrl+k/d to resize, 'a' for auto-show",
      "info",
    );

    if (this.autoShowDebug) {
      this.log("Event log auto-show is ON - will show on startup", "info");
    }

    // Update the debug box content if it's visible
    if (this.showDebug) {
      this.updateDebugBox();
    }

    this.screen.render();
  }

  updateWorkflows(
    workflows: WorkflowRun[],
    jobs: Map<string, WorkflowJob[]>,
    pullRequests?: PullRequest[],
    dockerServices?: DockerServiceStatus[],
  ): void {
    // Don't update the display if a modal dialog is open
    if (this.modalOpen) {
      // Still update the data but don't re-render the screen
      this.workflows = workflows;
      this.pullRequests = pullRequests || [];
      this.dockerServices = dockerServices || [];
      this.jobsCache = jobs; // Update the cache
      return;
    }

    // Set update flag to prevent key events during update
    this.uiUpdateInProgress = true;

    try {
      // Track changes before updating
      this.trackWorkflowChanges(workflows);

      const previousWorkflowCount = this.workflows.length;
      this.workflows = workflows;
      this.pullRequests = pullRequests || [];
      this.dockerServices = dockerServices || [];
      this.showPRs = pullRequests !== undefined;
      this.showDocker = dockerServices !== undefined;
      this.jobsCache = jobs; // Update the cache

      // Update debug info - now logged at trace level
      this.updateDebugInfo({
        showPRs: this.showPRs,
        prCount: this.pullRequests.length,
        workflowCount: this.workflows.length,
        jobsLoaded: jobs.size,
        lastUpdate: new Date().toLocaleTimeString(),
      });

      // Update PR header if needed (without recreating if possible)
      if (this.showPRs && this.prHeaderBox) {
        // Just update content without recreating the box
        const prContent = this.formatPRHeader(this.pullRequests);
        this.prHeaderBox.setContent(prContent);
      } else if (this.showPRs && !this.prHeaderBox) {
        this.createOrUpdatePRHeader();
      }

      // Update Docker header if needed (without recreating if possible)
      if (this.showDocker && this.dockerHeaderBox) {
        // Just update content without recreating the box
        const dockerContent = this.formatDockerHeader(this.dockerServices);
        this.dockerHeaderBox.setContent(dockerContent);
      } else if (this.showDocker && !this.dockerHeaderBox) {
        this.createOrUpdateDockerHeader();
      }

      // Only recreate layout if the number of workflows changed or grid doesn't exist
      if (workflows.length !== previousWorkflowCount || this.grid.length === 0) {
        this.layoutWorkflows();
      }
      
      // Always update content
      this.renderWorkflows(workflows, jobs);
    } finally {
      this.uiUpdateInProgress = false;
      // Stop refresh animation
      this.stopRefreshAnimation();
      // Process any key events that were queued during the update
      this.processQueuedKeyEvents();
    }
  }

  getCurrentWorkflows(): WorkflowRun[] {
    return this.workflows;
  }

  isModalOpen(): boolean {
    return this.modalOpen;
  }

  isUpdating(): boolean {
    return this.uiUpdateInProgress || this.layoutInProgress;
  }

  private renderTimer?: NodeJS.Immediate;
  
  private scheduleRender(): void {
    // Cancel any pending render
    if (this.renderTimer) {
      clearImmediate(this.renderTimer);
    }
    
    // Schedule render on next tick to batch updates
    this.renderTimer = setImmediate(() => {
      if (this.screen) {
        try {
          // Use render() without clearing - blessed handles differential updates
          this.screen.render();
        } catch (error: unknown) {
          // Catch and log render errors but don't crash
          const errorMessage = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `\nRender error: ${errorMessage?.substring(0, 100)}\n`,
          );
        }
      }
      this.renderTimer = undefined;
    });
  }

  private queueKeyEvent(handler: () => void): void {
    try {
      handler();
    } catch (error) {
      // Don't log here as it causes renders
      process.stderr.write(`\nKey handler error: ${error}\n`);
    }
  }

  private processQueuedKeyEvents(): void {
    // Process all queued events
    while (this.keyEventQueue.length > 0) {
      const handler = this.keyEventQueue.shift();
      if (handler) {
        try {
          handler();
        } catch (error) {
          this.log(`Error processing queued key event: ${error}`, "error");
        }
      }
    }
  }

  private toggleLogLevel(): void {
    // Cycle through log levels: info -> debug -> trace -> info
    if (this.logLevel === "info") {
      this.logLevel = "debug";
    } else if (this.logLevel === "debug") {
      this.logLevel = "trace";
    } else {
      this.logLevel = "info";
    }

    // Save the preference
    this.savePreferences();

    // Log the change
    this.log(`Log level: ${this.logLevel} (F10 to cycle)`, "info");

    // Update the debug box to reflect the filter change
    if (this.showDebug) {
      this.updateDebugBox();
    }
  }

  private layoutWorkflows(): void {
    // Prevent recursive layout calls
    if (this.layoutInProgress) return;
    this.layoutInProgress = true;

    // Layout is being called - this should only happen on refresh, not on key presses

    try {
      // Build new grid before destroying old one (double-buffering)
      const newGrid: blessed.Widgets.BoxElement[] = [];

    // Calculate available height (account for status bar, debug box, PR header, and Docker header if shown)
    const debugHeight = this.showDebug ? this.debugBoxHeight : 0;
    const prHeaderHeight = this.showPRs ? 5 : 0;
    const dockerHeaderHeight = this.showDocker ? 5 : 0;
    const screenHeight =
      (this.screen.height as number) - 4 - debugHeight - prHeaderHeight - dockerHeaderHeight; // Status bar is now 4 high
    const screenWidth = this.screen.width as number;
    const count = this.workflows.length;
    const topOffset = prHeaderHeight + dockerHeaderHeight; // Offset for PR and Docker headers

      if (count === 0) {
        // Show empty state
        const emptyBox = blessed.box({
          parent: this.screen,
          top: topOffset,
          left: 0,
          width: "100%",
          height: screenHeight,
          content: `{center}No running workflows found{/center}

{center}Monitoring for in-progress and queued workflows...{/center}
{center}Press 'r' to refresh or 'q' to quit{/center}

{center}Completed workflows will be shown until dismissed{/center}
{center}To see activity, trigger a workflow in your repositories{/center}`,
          tags: true,
          border: {
            type: "line",
          },
          style: {
            fg: "gray",
            border: {
              fg: "#f0f0f0",
            },
          },
        });
        newGrid.push(emptyBox);

        // Now swap grids atomically
        this.grid.forEach((box) => {
          box.destroy();
        });
        this.grid = newGrid;
        return;
      }

      // Calculate grid layout - use full width for single card
      this.cols = count === 1 ? 1 : Math.min(Math.ceil(Math.sqrt(count)), 3);
      this.rows = Math.ceil(count / this.cols);

      const boxWidth = Math.floor(screenWidth / this.cols);
      const boxHeight = Math.floor(screenHeight / this.rows);

      // Store box width for use in formatting
      this.currentBoxWidth = boxWidth;

      // Create grid of boxes
      for (let i = 0; i < count; i++) {
        const row = Math.floor(i / this.cols);
        const col = i % this.cols;
        const workflow = this.workflows[i];
        const borderColor = workflow
          ? this.getBorderColor(workflow, i === this.selectedIndex)
          : "#f0f0f0";

        const box = blessed.box({
          parent: this.screen,
          top: topOffset + row * boxHeight,
          left: col * boxWidth,
          width: boxWidth,
          height: boxHeight,
          tags: true,
          border: {
            type: "line",
          },
          style: {
            fg: "white",
            border: {
              fg: borderColor,
            },
          },
          scrollable: true,
          alwaysScroll: true,
          keys: true,
          vi: false,
        });

        newGrid.push(box);
      }

      // Now swap grids atomically - destroy old boxes AFTER creating new ones
      const oldGrid = this.grid;
      this.grid = newGrid;

      // Ensure selection highlighting is applied after creating all boxes
      this.highlightSelected();

      // Destroy old boxes after new ones are in place
      oldGrid.forEach((box) => {
        box.destroy();
      });
    } finally {
      this.layoutInProgress = false;
    }
  }

  private renderWorkflows(
    workflows: WorkflowRun[],
    jobs: Map<string, WorkflowJob[]>,
  ): void {
    // Batch all content updates before rendering
    workflows.forEach((workflow, index) => {
      if (index >= this.grid.length) return;

      const box = this.grid[index];
      const isSelected = index === this.selectedIndex;
      const content = this.formatWorkflowContent(
        workflow,
        jobs.get(`${workflow.id}`) || [],
        isSelected,
      );
      
      // Only update if content actually changed
      const currentContent = box.getContent();
      if (currentContent !== content) {
        box.setContent(content);
      }
    });

    this.updateStatusBar();

    // Schedule a single batched render
    this.scheduleRender();
  }

  private formatWorkflowContent(
    workflow: WorkflowRun,
    jobs: WorkflowJob[],
    isSelected: boolean = false,
  ): string {
    const lines: string[] = [];

    // Determine if we should show all steps based on number of workflows
    const showAllSteps = this.workflows.length <= 2;

    // Map of known repo to working directory names (same as PRs)
    const repoToWorkingDir: Record<string, string> = {
      "phenixcrm/clean": "phenix",
      "phenixcrm/phenixcrm": "phenixcrm",
      // Add more mappings as needed
    }

    // Get working directory name
    const fullRepoName = `${workflow.repository.owner}/${workflow.repository.name}`;
    const projectName = repoToWorkingDir[fullRepoName] || workflow.repository.name;

    // Header with project name (working dir) and actual branch the workflow is running on
    if (isSelected) {
      // Create full-width inverted header block
      const branchName = workflow.headBranch;
      const repoLine = ` ${projectName} \ue725 ${branchName}`;
      const runLine = ` ${workflow.workflowName || "CI"} Run #${workflow.runNumber}`;

      // Pad to actual card width minus border (2 chars) and some margin
      const padWidth = Math.max(30, this.currentBoxWidth - 4);
      lines.push(`{inverse}${repoLine.padEnd(padWidth)}{/inverse}`);
      lines.push(`{inverse}${runLine.padEnd(padWidth)}{/inverse}`);
    } else {
      const branchName = workflow.headBranch;
      lines.push(
        ` {bold}${projectName} \ue725 ${branchName}{/bold}`,
      );
      lines.push(` ${workflow.workflowName || "CI"} Run #{yellow-fg}${workflow.runNumber}{/yellow-fg}`);
    }
    lines.push("");

    // Event and commit info (removed duplicate branch line)
    lines.push(` Triggered by: {magenta-fg}${workflow.event}{/magenta-fg}`);
    if (workflow.headSha) {
      lines.push(` Commit: {gray-fg}${workflow.headSha.substring(0, 7)}{/gray-fg}`);
    }
    // Show repository owner in smaller text if needed
    lines.push(` Repo: {gray-fg}${workflow.repository.owner}/${workflow.repository.name}{/gray-fg}`);
    lines.push("");

    // Status with more detail
    const statusIcon = this.getStatusIcon(workflow.status, workflow.conclusion);
    const statusColor = this.getStatusColor(
      workflow.status,
      workflow.conclusion,
    );
    lines.push(
      ` Status: {${statusColor}-fg}${statusIcon} ${workflow.status.toUpperCase()}{/}`,
    );

    if (workflow.conclusion) {
      lines.push(
        ` Result: {${statusColor}-fg}${workflow.conclusion.toUpperCase()}{/}`,
      );
    }

    // Show dismiss hint for completed workflows
    if (workflow.status === "completed") {
      lines.push(` {gray-fg}Press 'd' to dismiss{/gray-fg}`);
    }

    // Timing information
    if (workflow.startedAt) {
      const startTime = new Date(workflow.startedAt);
      const now = new Date();
      const duration = Math.floor((now.getTime() - startTime.getTime()) / 1000);
      const minutes = Math.floor(duration / 60);
      const seconds = duration % 60;
      lines.push(` Running: {white-fg}${minutes}m ${seconds}s{/white-fg}`);
    }

    if (workflow.createdAt !== workflow.startedAt) {
      const queueTime =
        new Date(workflow.startedAt || workflow.createdAt).getTime() -
        new Date(workflow.createdAt).getTime();
      if (queueTime > 1000) {
        const queueSeconds = Math.floor(queueTime / 1000);
        lines.push(` Queue time: {gray-fg}${queueSeconds}s{/gray-fg}`);
      }
    }

    lines.push("");

    // Jobs with detailed step information
    if (jobs.length > 0) {
      lines.push(" {bold}Jobs & Steps:{/bold}");
      jobs.forEach((job) => {
        const jobIcon = this.getStatusIcon(job.status, job.conclusion);
        const jobColor = this.getStatusColor(job.status, job.conclusion);
        const runnerInfo = job.runner_name ? ` {gray-fg}[${job.runner_name}]{/}` : "";
        lines.push(` {${jobColor}-fg}${jobIcon} ${job.name}{/}${runnerInfo}`);

        if (job.steps && job.steps.length > 0) {
          // Show progress for running jobs
          if (job.status === "in_progress") {
            const completedSteps = job.steps.filter(
              (s) => s.status === "completed",
            ).length;
            const totalSteps = job.steps.length;
            const currentStepIndex = job.steps.findIndex(
              (s) => s.status === "in_progress",
            );

            lines.push(
              `   Progress: {cyan-fg}${completedSteps}/${totalSteps} steps{/cyan-fg}`,
            );

            if (currentStepIndex >= 0) {
              // Determine how many steps to show based on available space
              let startIndex: number;
              let endIndex: number;

              if (showAllSteps) {
                // Show all steps when there are few workflows
                startIndex = 0;
                endIndex = job.steps.length;
              } else {
                // Show 2-3 recently completed steps before current (existing behavior)
                startIndex = Math.max(0, currentStepIndex - 2);
                endIndex = Math.min(job.steps.length, currentStepIndex + 4);
              }

              for (let i = startIndex; i < endIndex; i++) {
                const step = job.steps[i];
                const stepNumber = `${i + 1}/${totalSteps}`;

                if (step.status === "completed") {
                  const stepIcon =
                    step.conclusion === "success"
                      ? "✓"
                      : step.conclusion === "failure"
                        ? "✗"
                        : step.conclusion === "skipped"
                          ? "⊜"
                          : "○";
                  const stepColor =
                    step.conclusion === "success"
                      ? "green"
                      : step.conclusion === "failure"
                        ? "red"
                        : "gray";

                  let duration = "";
                  if (step.startedAt && step.completedAt) {
                    const dur = Math.floor(
                      (new Date(step.completedAt).getTime() -
                        new Date(step.startedAt).getTime()) /
                        1000,
                    );
                    duration = ` (${dur}s)`;
                  }

                  lines.push(
                    `   {${stepColor}-fg}${stepIcon}{/} {gray-fg}${stepNumber}{/} ${step.name}{gray-fg}${duration}{/}`,
                  );
                } else if (step.status === "in_progress") {
                  // Current running step - highlighted
                  const stepDuration = step.startedAt
                    ? Math.floor(
                        (Date.now() - new Date(step.startedAt).getTime()) /
                          1000,
                      )
                    : 0;

                  lines.push(
                    `   {yellow-fg}▶ ${stepNumber} {bold}${step.name}{/bold} (${stepDuration}s){/}`,
                  );
                } else {
                  // Upcoming steps (pending, waiting)
                  const stepIcon = step.status === "waiting" ? "⏳" : "○";
                  lines.push(
                    `   {gray-fg}${stepIcon} ${stepNumber} ${step.name}{/}`,
                  );
                }
              }

              // Show if there are more steps after what we're displaying (only when not showing all)
              if (!showAllSteps && endIndex < job.steps.length) {
                const remainingSteps = job.steps.length - endIndex;
                lines.push(
                  `   {gray-fg}... and ${remainingSteps} more step${remainingSteps > 1 ? "s" : ""}{/}`,
                );
              }
            }
          }

          // Show completion info for completed jobs
          else if (job.status === "completed") {
            if (showAllSteps && job.steps && job.steps.length > 0) {
              // Show all completed steps with details when there's room
              job.steps.forEach((step, index) => {
                const stepNumber = `${index + 1}/${job.steps?.length}`;
                const stepIcon =
                  step.conclusion === "success"
                    ? "✓"
                    : step.conclusion === "failure"
                      ? "✗"
                      : step.conclusion === "skipped"
                        ? "⊜"
                        : "○";
                const stepColor =
                  step.conclusion === "success"
                    ? "green"
                    : step.conclusion === "failure"
                      ? "red"
                      : "gray";

                let duration = "";
                if (step.startedAt && step.completedAt) {
                  const dur = Math.floor(
                    (new Date(step.completedAt).getTime() -
                      new Date(step.startedAt).getTime()) /
                      1000,
                  );
                  duration = ` (${dur}s)`;
                }

                lines.push(
                  `   {${stepColor}-fg}${stepIcon}{/} {gray-fg}${stepNumber}{/} ${step.name}{gray-fg}${duration}{/}`,
                );
              });
            } else {
              // Show summary when there's limited space (existing behavior)
              if (job.conclusion === "success") {
                lines.push(
                  `   {green-fg}✓ All ${job.steps.length} steps completed{/green-fg}`,
                );
              } else if (job.conclusion === "failure") {
                const failedStep = job.steps.find(
                  (s) => s.conclusion === "failure",
                );
                if (failedStep) {
                  lines.push(
                    `   {red-fg}✗ Failed at: ${failedStep.name}{/red-fg}`,
                  );
                }
              }
            }
          }

          // Show queued job steps when there's room
          else if (
            showAllSteps &&
            (job.status === "queued" || job.status === "waiting")
          ) {
            if (job.steps && job.steps.length > 0) {
              lines.push(
                `   {gray-fg}Queued - ${job.steps.length} steps pending{/gray-fg}`,
              );
              job.steps.forEach((step, index) => {
                const stepNumber = `${index + 1}/${job.steps?.length}`;
                lines.push(
                  `   {gray-fg}○ ${stepNumber} ${step.name}{/gray-fg}`,
                );
              });
            } else {
              lines.push(`   {gray-fg}Waiting to start...{/gray-fg}`);
            }
          }
        }

        lines.push("");
      });
    } else {
      lines.push(" {gray-fg}Loading job details...{/gray-fg}");
    }

    return lines.join("\n");
  }

  private getStatusIcon(status: string, conclusion?: string): string {
    if (status === "completed") {
      switch (conclusion) {
        case "success":
          return "✓";
        case "failure":
          return "✗";
        case "cancelled":
          return "⊘";
        case "skipped":
          return "⊜";
        default:
          return "?";
      }
    }

    switch (status) {
      case "in_progress":
        return "●";
      case "queued":
        return "○";
      default:
        return "?";
    }
  }

  private getStatusColor(status: string, conclusion?: string): string {
    if (status === "completed") {
      switch (conclusion) {
        case "success":
          return "green";
        case "failure":
          return "red";
        case "cancelled":
          return "gray";
        case "skipped":
          return "gray";
        default:
          return "white";
      }
    }

    switch (status) {
      case "in_progress":
        return "yellow";
      case "queued":
        return "gray";
      default:
        return "white";
    }
  }

  private updateStatusBar(): void {
    const runningCount = this.workflows.filter(
      (w) => w.status === "in_progress",
    ).length;
    const queuedCount = this.workflows.filter(
      (w) => w.status === "queued" || w.status === "waiting",
    ).length;
    const completedCount = this.workflows.filter(
      (w) => w.status === "completed",
    ).length;

    // Animated refresh indicator - using braille spinner for smoothness
    // Always reserve space for the spinner to prevent text jumping
    const refreshFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const refreshIndicator = this.refreshAnimationTimer
      ? `{yellow-fg}${refreshFrames[this.refreshAnimationFrame % refreshFrames.length]}{/} `
      : "  "; // Two spaces when not spinning to prevent text jumping

    // Use last refresh time if available
    const updateTime = this.lastRefreshTime || new Date();

    // Line 1: Status counts and refresh indicator
    let line1 = `${refreshIndicator}Last Update: ${updateTime.toLocaleTimeString()} | `;
    line1 += `{yellow-fg}●{/} Running: ${runningCount} | `;
    line1 += `{gray-fg}○{/} Queued: ${queuedCount}`;
    if (completedCount > 0) {
      line1 += ` | {green-fg}✓{/} Done: ${completedCount}`;
    }
    line1 += ` | Total: ${this.workflows.length}`;

    // Line 2: Keyboard shortcuts - more compact without obvious labels
    const shortcuts = [
      "?",
      "q",
      "↑↓←→",
      "Enter: open",
      "d/D: dismiss",
      "k: kill",
      "F9: log",
    ];
    const line2 = shortcuts.join(" | ");

    // Only update if content changed or spinner is active
    const contentChanged =
      line1 !== this.lastStatusLine1 || line2 !== this.lastStatusLine2;

    if (contentChanged || this.refreshAnimationTimer) {
      this.statusBox.setContent(
        `{center}${line1}{/center}\n{center}{gray-fg}${line2}{/gray-fg}{/center}`,
      );
      this.lastStatusLine1 = line1;
      this.lastStatusLine2 = line2;
      this.screen.render();
    }
  }

  onRefresh(callback: () => void): void {
    this.screen.on("manual-refresh", callback);
  }

  onOpenWorkflow(callback: (workflow: WorkflowRun) => void): void {
    this.screen.on("open-workflow", callback);
  }

  onDismissWorkflow(callback: (workflow: WorkflowRun) => void): void {
    this.screen.on("dismiss-workflow", callback);
  }

  onDismissAllCompleted(callback: (workflows: WorkflowRun[]) => void): void {
    this.screen.on("dismiss-all-completed", callback);
  }

  onOpenPR(callback: (pr: PullRequest) => void): void {
    this.screen.on("open-pr", callback);
  }

  onKillWorkflow(callback: (workflow: WorkflowRun) => void): void {
    this.screen.on("kill-workflow", callback);
  }

  onRestartDocker(callback: (service: {service: {name: string, state: string, health?: string}, repo: string}) => void): void {
    this.screen.on("restart-docker", callback);
  }

  showError(message: string): void {
    // Clear existing content
    this.grid.forEach((box) => {
      box.destroy();
    });
    this.grid = [];

    const errorBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "80%",
      height: "60%",
      content: `{center}{bold}Error Loading Workflows{/bold}{/center}

{red-fg}${message}{/red-fg}

{center}Press 'r' to retry or 'q' to quit{/center}`,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        border: {
          fg: "red",
        },
      },
    });

    this.grid.push(errorBox);
    this.updateStatusBar();
    this.screen.render();
  }

  private cleanup(): void {
    // Save preferences before exit
    this.savePreferences();

    // Disable mouse tracking before exit
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?1000l");
      process.stdout.write("\x1b[?1002l");
      process.stdout.write("\x1b[?1003l");
      process.stdout.write("\x1b[?1006l");
    }

    // Emit exit event for the app to handle
    this.screen.emit("exit");
    // Clean shutdown
    this.destroy();
    process.exit(0);
  }

  onExit(callback: () => void): void {
    this.screen.on("exit", callback);
  }

  showLoadingInStatus(): void {
    // Don't update status if modal is open
    if (this.modalOpen) return;

    // Start animation if not already running
    if (!this.refreshAnimationTimer) {
      this.startRefreshAnimation();
    }

    // Log refresh
    this.log("Refreshing data...", "debug");
  }

  private startRefreshAnimation(): void {
    // Don't start if already running
    if (this.refreshAnimationTimer) return;

    // Reset frame counter
    this.refreshAnimationFrame = 0;

    // Update immediately to show spinner
    this.updateStatusBar();

    // Start animation with moderate speed - not too fast to be jarring
    this.refreshAnimationTimer = setInterval(() => {
      this.refreshAnimationFrame++;
      this.updateStatusBar();
    }, 300); // 300ms for smooth, non-jarring animation
  }

  stopRefreshAnimation(): void {
    // Stop animation timer
    if (this.refreshAnimationTimer) {
      clearInterval(this.refreshAnimationTimer);
      this.refreshAnimationTimer = undefined;
    }
    this.refreshAnimationFrame = 0;

    // Record the actual refresh time
    this.lastRefreshTime = new Date();

    // Update status bar to remove refresh indicator
    this.updateStatusBar();
  }

  destroy(): void {
    // Save preferences before destroying
    this.savePreferences();

    // Clean up any event listeners
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");

    // Ensure mouse tracking is disabled on exit
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?1000l");
      process.stdout.write("\x1b[?1002l");
      process.stdout.write("\x1b[?1003l");
      process.stdout.write("\x1b[?1006l");
    }

    // Destroy the blessed screen
    if (this.screen) {
      this.screen.destroy();
    }
  }

  private createOrUpdatePRHeader(): void {
    // Remove existing PR header if it exists
    if (this.prHeaderBox) {
      this.prHeaderBox.destroy();
    }

    // Position PR header below Docker header if Docker header is shown
    const prTop = this.showDocker ? 5 : 0;

    // Create PR header box with border
    this.prHeaderBox = blessed.box({
      parent: this.screen,
      top: prTop,
      left: 0,
      width: "100%",
      height: 5,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        // bg removed - inherit terminal background
        border: {
          fg: "#666666",
        },
      },
    });

    // Format PR content
    const prContent = this.formatPRHeader(this.pullRequests);
    this.prHeaderBox.setContent(prContent);
  }

  private createOrUpdateDockerHeader(): void {
    // Remove existing Docker header if it exists
    if (this.dockerHeaderBox) {
      this.dockerHeaderBox.destroy();
    }

    // Position Docker header above PR header if PR header is shown
    const dockerTop = 0;

    // Create Docker header box with border
    this.dockerHeaderBox = blessed.box({
      parent: this.screen,
      top: dockerTop,
      left: 0,
      width: "100%",
      height: 5,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        // bg removed - inherit terminal background
        border: {
          fg: "#888888",
        },
      },
    });

    // Format Docker content
    const dockerContent = this.formatDockerHeader(this.dockerServices);
    this.dockerHeaderBox.setContent(dockerContent);

    // If PR header exists, move it below Docker header
    if (this.prHeaderBox) {
      this.prHeaderBox.top = 5;
    }
  }

  private formatDockerHeader(dockerStatuses: DockerServiceStatus[]): string {
    if (dockerStatuses.length === 0) {
      return "{center}{gray-fg}No Docker services found{/gray-fg}{/center}"
    }

    const lines: string[] = []
    
    // Rebuild flat list of services for navigation
    this.flatDockerServices = [];
    
    // Collect all services with simplified format
    const services: Array<{name: string, icon: string, color: string, repo: string, state: string, health?: string}> = []
    let hasErrors = false;

    for (const status of dockerStatuses) {
      if (status.error) {
        hasErrors = true;
        if (status.error.includes("not installed")) {
          lines.push("{center}{red-fg}⚠ Docker is not installed or not available{/red-fg}{/center}")
          return lines.join("\n")
        }
        continue;
      }

      if (status.services.length === 0) {
        continue;
      }

      const repoName = status.repository.split("/")[1] || status.repository;
      
      for (const service of status.services) {
        // Strip project name prefix from service name if present
        let serviceName = service.name;
        // Common patterns: projectname-servicename or projectname_servicename
        const prefixPatterns = [
          `${repoName}-`,
          `${repoName}_`,
          `${repoName.toLowerCase()}-`,
          `${repoName.toLowerCase()}_`
        ];
        for (const prefix of prefixPatterns) {
          if (serviceName.startsWith(prefix)) {
            serviceName = serviceName.substring(prefix.length);
            break;
          }
        }
        
        // Add to flat list for navigation
        this.flatDockerServices.push({
          service: {
            name: service.name, // Keep original name for restart command
            state: service.state,
            health: service.health
          },
          repo: repoName
        });
        
        let icon = ""
        let color = "white"

        // Simplified icon logic - focus on health for running services
        if (service.state === "running") {
          if (service.health === "healthy") {
            icon = "✓"
            color = "green"
          } else if (service.health === "unhealthy") {
            icon = "✗"
            color = "red"
          } else if (service.health === "starting") {
            icon = "◐"
            color = "yellow"
          } else {
            icon = "●"
            color = "green"
          }
        } else if (service.state === "exited") {
          icon = "○"
          color = "gray"
        } else if (service.state === "restarting") {
          icon = "↻"
          color = "yellow"
        } else if (service.state === "paused") {
          icon = "⏸"
          color = "yellow"
        } else {
          icon = "?"
          color = "gray"
        }

        services.push({name: serviceName, icon, color, repo: repoName, state: service.state, health: service.health})
      }
    }

    if (services.length === 0 && !hasErrors) {
      return "{center}{gray-fg}No Docker services running{/gray-fg}{/center}"
    }

    // Group by project (repo name without owner) for better organization
    const servicesByRepo = new Map<string, typeof services>()
    for (const service of services) {
      const projectName = service.repo  // Already just the project name from earlier
      if (!servicesByRepo.has(projectName)) {
        servicesByRepo.set(projectName, [])
      }
      servicesByRepo.get(projectName)?.push(service)
    }

    // Format as compact inline list per repo with left margin
    let serviceIndex = 0;
    for (const [project, repoServices] of servicesByRepo) {
      const serviceItems = repoServices.map((s, idx) => {
        const isSelected = this.selectionMode === "docker" && serviceIndex + idx === this.selectedDockerIndex;
        const serviceText = `{${s.color}-fg}${s.icon}{/} ${s.name}`;
        
        if (isSelected) {
          // Apply inverse to selected service with padding for button-like appearance
          const plainText = ` ${s.icon} ${s.name} `; // Added spaces on both sides
          return `{inverse}${plainText}{/inverse}`;
        }
        return serviceText;
      }).join("  "); // Two spaces between services
      
      lines.push(` {gray-fg}[${project}]{/gray-fg} ${serviceItems}`); // 1-space margin
      serviceIndex += repoServices.length;
    }

    // If we have too many lines, truncate and show count
    const maxLines = 4  // We can show more lines now without the whale
    if (lines.length > maxLines) {
      const totalServices = services.length
      lines.splice(maxLines, lines.length, ` {gray-fg}... ${totalServices} services total{/gray-fg}`) // 1-space margin
    }

    return lines.join("\n"); // All lines fit in 5-height box now
  }

  private formatPRHeader(prs: PullRequest[]): string {
    if (prs.length === 0) {
      return "{center}{gray-fg}No open pull requests{/gray-fg}{/center}"
    }

    const lines: string[] = [];

    // Map of known repo to working directory names
    const repoToWorkingDir: Record<string, string> = {
      "phenixcrm/clean": "phenix",
      "phenixcrm/phenixcrm": "phenixcrm",
      // Add more mappings as needed
    }

    // Group PRs by repository
    const prsByRepo = new Map<string, PullRequest[]>()
    for (const pr of prs) {
      const key = `${pr.repository.owner}/${pr.repository.name}`
      if (!prsByRepo.has(key)) {
        prsByRepo.set(key, [])
      }
      prsByRepo.get(key)?.push(pr)
    }

    // Format each PR as branch flow
    const prLines: string[] = [];
    let currentIndex = 0;
    for (const [repo, repoPrs] of prsByRepo) {
      for (const pr of repoPrs) {
        const isSelected = this.selectionMode === "prs" && currentIndex === this.selectedPRIndex;
        let statusIcon = ""
        let statusColor = "white"

        // Check status for icon
        if (pr.statusCheckRollup) {
          switch (pr.statusCheckRollup.state) {
            case "SUCCESS":
              statusIcon = "✓"
              statusColor = "green"
              break;
            case "FAILURE":
            case "ERROR":
              statusIcon = "✗"
              statusColor = "red"
              break;
            case "PENDING":
            case "EXPECTED":
              statusIcon = "●"
              statusColor = "yellow"
              break;
          }
        } else {
          statusIcon = "○"
          statusColor = "gray"
        }

        // Add draft indicator to status icon if needed
        if (pr.draft || pr.isDraft) {
          statusIcon = "◐" // Half-circle for draft
          statusColor = "gray"
        }

        // Add conflict indicator if not mergeable
        let conflictIndicator = ""
        if (pr.mergeable === "CONFLICTING") {
          conflictIndicator = " {red-fg}⚠{/red-fg}"  // Warning triangle for conflicts
        }

        // Format: PR# [project] source -> target icon [conflict]
        // Use working directory name if we have a mapping, otherwise use repo name
        const projectName = repoToWorkingDir[repo] || repo.split("/")[1] || repo;
        const prText = `{cyan-fg}PR #${pr.number}{/} {gray-fg}[${projectName}]{/gray-fg} ${pr.headRefName} → ${pr.baseRefName} {${statusColor}-fg}${statusIcon}{/}${conflictIndicator}`
        
        // Format the PR line
        let prLine: string
        if (isSelected && this.selectionMode === "prs") {
          // For selected PR, create plain text and apply inverse to entire padded line
          const plainText = `PR #${pr.number} [${projectName}] ${pr.headRefName} → ${pr.baseRefName} ${statusIcon}${pr.mergeable === "CONFLICTING" ? " ⚠" : ""}`
          // Pad the text to a reasonable width before applying inverse
          const paddedText = plainText.padEnd(Math.min(80, (this.screen.width as number) - 4))
          prLine = `{inverse}${paddedText}{/inverse}`
        } else {
          prLine = prText
        }
        
        prLines.push(prLine)
        currentIndex++
      }
    }

    // Show up to 2 PRs horizontally if space allows, otherwise just list them
    const screenWidth = this.screen.width as number
    if (screenWidth > 160 && prLines.length >= 2) {
      // Two column layout
      const half = Math.ceil(prLines.length / 2)
      const leftColumn = prLines.slice(0, half)
      const rightColumn = prLines.slice(half)

      for (
        let i = 0;
        i < Math.max(leftColumn.length, rightColumn.length);
        i++
      ) {
        const left = leftColumn[i] || ""
        const right = rightColumn[i] || ""
        // Simple two column layout with left margin - left takes up to 80 chars, right gets the rest
        lines.push(` ${left.padEnd(Math.min(80, screenWidth / 2))} ${right}`)  // 1-space margin
      }
    } else {
      // Single column layout with left margin - now we can show 4 PRs since we removed the header
      for (const prLine of prLines.slice(0, 4)) {
        lines.push(` ${prLine}`)  // 1-space margin
      }
      if (prLines.length > 4) {
        lines.push(` {gray-fg}... and ${prLines.length - 4} more{/gray-fg}`)  // 1-space margin
      }
    }

    return lines.join("\n"); // All lines available for PRs now
  }

  log(
    message: string,
    type: "info" | "event" | "debug" | "trace" | "error" = "info",
  ): void {
    const timestamp = new Date().toLocaleTimeString();
    const typeColors = {
      info: "{white-fg}",
      event: "{green-fg}",
      debug: "{cyan-fg}",
      trace: "{gray-fg}",
      error: "{red-fg}",
    };
    const color = typeColors[type as keyof typeof typeColors] || "{white-fg}";
    const formattedMessage = `${color}[${timestamp}] ${message}{/}`;

    this.logMessages.push({
      message,
      type,
      timestamp,
      formatted: formattedMessage,
    });

    // Keep only the last N messages
    if (this.logMessages.length > this.maxLogMessages) {
      this.logMessages = this.logMessages.slice(-this.maxLogMessages);
    }

    // Update the debug box content if it's visible (but batch updates)
    if (this.showDebug && !this.debugBox.hidden) {
      // Use a debounced update to avoid too many renders
      if (!this.debugUpdateTimer) {
        this.debugUpdateTimer = setTimeout(() => {
          this.updateDebugBox();
          this.debugUpdateTimer = undefined;
        }, 100); // Update after 100ms of no new logs
      }
    }
  }

  private updateDebugBox(): void {
    if (!this.debugBox) return;

    // Define log level hierarchy
    const levelHierarchy = {
      info: 0, // Show only info, event, and error
      debug: 1, // Also show debug
      trace: 2, // Show everything including trace
    };

    const currentLevelValue = levelHierarchy[this.logLevel];

    // Filter messages based on log level
    const filteredMessages = this.logMessages
      .filter((msg) => {
        // Always show info, event, and error
        if (msg.type === "info" || msg.type === "event" || msg.type === "error")
          return true;
        // Show debug if level is debug or higher
        if (msg.type === "debug")
          return currentLevelValue >= levelHierarchy.debug;
        // Show trace only if level is trace
        if (msg.type === "trace")
          return currentLevelValue >= levelHierarchy.trace;
        return true;
      })
      .map((msg) => msg.formatted);

    // Create colored log level indicator for the title
    const levelIndicator =
      this.logLevel === "info"
        ? "{white-fg}[INFO]{/}"
        : this.logLevel === "debug"
          ? "{cyan-fg}[DEBUG]{/}"
          : "{gray-fg}[TRACE]{/}";

    // Auto-show indicator - clear ON/OFF text
    const autoShowStatus = this.autoShowDebug
      ? "{green-fg}ON{/}"
      : "{gray-fg}OFF{/}";

    // Update the label to show colored log level and auto-show status
    this.debugBox.setLabel(
      ` Event Log ${levelIndicator} (F9: hide, F10: cycle level, a: auto-open ${autoShowStatus}) `,
    );

    // Set filtered messages as scrollable content
    this.debugBox.setContent(filteredMessages.join("\n"));

    // Auto-scroll to bottom to show latest messages
    this.debugBox.setScrollPerc(100);

    this.screen.render();
  }

  private toggleDebug(): void {
    try {
      this.showDebug = !this.showDebug;

      if (this.showDebug) {
        this.debugBox.show();
        const autoShowStatus = this.autoShowDebug
          ? " (auto-show ON)"
          : " (auto-show OFF)";
        const debugFilterStatus =
          this.logLevel === "trace"
            ? " (showing all)"
            : this.logLevel === "debug"
              ? " (showing debug)"
              : " (info only)";
        this.log(
          `Event log enabled (height: ${this.debugBoxHeight} lines, Ctrl+k/d to resize)${autoShowStatus}${debugFilterStatus}`,
          "info",
        );
        this.updateDebugBox();
      } else {
        this.debugBox.hide();
      }

      // Re-layout to adjust for the debug box
      this.layoutWorkflows();
      this.screen.render();
    } catch (error) {
      // Try to log the error if possible
      if (this.logMessages) {
        this.log(`Error toggling debug: ${error}`, "error");
      }
    }
  }

  private toggleAutoShowDebug(): void {
    this.autoShowDebug = !this.autoShowDebug;

    // Save the preference
    this.savePreferences();

    // Show feedback about the setting change
    if (this.autoShowDebug) {
      this.log(
        "Event log will auto-show on startup ✓ ('a' to toggle)",
        "event",
      );
    } else {
      this.log("Event log will be hidden on startup ('a' to toggle)", "event");
    }

    // Update the title to reflect the new setting
    if (this.showDebug) {
      this.updateDebugBox();
    }

    // Don't change current visibility - this setting only affects startup behavior
  }

  private updateDebugInfo(info: {
    showPRs: boolean;
    prCount: number;
    workflowCount: number;
    jobsLoaded: number;
    lastUpdate: string;
  }): void {
    // Log state changes at trace level (most verbose)
    this.log(
      `State: PRs=${info.prCount}, Workflows=${info.workflowCount}, Jobs=${info.jobsLoaded}`,
      "trace",
    );
  }

  private resizeDebugBox(delta: number): void {
    const newHeight = this.debugBoxHeight + delta;

    // Constrain within min/max bounds
    if (newHeight < this.minDebugHeight || newHeight > this.maxDebugHeight) {
      return;
    }

    this.debugBoxHeight = newHeight;
    this.debugBox.height = newHeight;

    // Log the resize
    this.log(
      `Event log resized to ${newHeight} lines (Ctrl+k/d to resize)`,
      "info",
    );

    // Save preferences
    this.savePreferences();

    // Re-layout to adjust for new height
    this.layoutWorkflows();
    this.screen.render();
  }

  private loadPreferences(): void {
    try {
      const prefsPath = path.join(os.homedir(), ".gh-hud-prefs.json");

      // Store preference info for logging after UI is ready
      this.pendingPrefsLog = [`Preferences file: ${prefsPath}`];

      if (fs.existsSync(prefsPath)) {
        const content = fs.readFileSync(prefsPath, "utf8");
        if (content) {
          const prefs = JSON.parse(content);
          this.pendingPrefsLog.push(
            `Loaded preferences: ${JSON.stringify(prefs)}`,
          );

          if (prefs.debugBoxHeight !== undefined) {
            const oldHeight = this.debugBoxHeight;
            this.debugBoxHeight = Math.max(
              this.minDebugHeight,
              Math.min(this.maxDebugHeight, prefs.debugBoxHeight),
            );
            this.pendingPrefsLog.push(
              `Debug box height: ${oldHeight} → ${this.debugBoxHeight}`,
            );
            // Apply the saved height to the debug box
            if (this.debugBox) {
              this.debugBox.height = this.debugBoxHeight;
            }
          }

          // Load auto-show preference
          if (prefs.autoShowDebug !== undefined) {
            this.autoShowDebug = prefs.autoShowDebug;
            // Apply the auto-show preference on startup
            this.showDebug = prefs.autoShowDebug;
            this.pendingPrefsLog.push(
              `Auto-show debug: ${prefs.autoShowDebug ? "ON" : "OFF"}`,
            );
            this.pendingPrefsLog.push(
              `Debug box will be ${this.showDebug ? "shown" : "hidden"} on startup`,
            );
          }

          // Load log level preference
          if (prefs.logLevel !== undefined) {
            this.logLevel = prefs.logLevel;
            this.pendingPrefsLog.push(`Log level: ${prefs.logLevel}`);
          }
        }
      } else {
        this.pendingPrefsLog.push("No preferences file found, using defaults");
      }
    } catch (error: unknown) {
      // Store error for logging after UI is ready
      this.pendingPrefsLog = [
        `Failed to load preferences: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  }

  private savePreferences(): void {
    try {
      const prefsPath = path.join(os.homedir(), ".gh-hud-prefs.json");

      const prefs = {
        debugBoxHeight: this.debugBoxHeight,
        autoShowDebug: this.autoShowDebug,
        logLevel: this.logLevel,
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
      this.log(
        `Preferences saved: height=${this.debugBoxHeight}, auto-show=${this.autoShowDebug}`,
        "debug",
      );
    } catch (error: unknown) {
      this.log(
        `Failed to save preferences: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  // Track workflow status changes
  private trackWorkflowChanges(newWorkflows: WorkflowRun[]): void {
    const oldWorkflowMap = new Map(this.workflows.map((w) => [w.id, w]));

    for (const workflow of newWorkflows) {
      const oldWorkflow = oldWorkflowMap.get(workflow.id);

      if (!oldWorkflow) {
        // New workflow appeared
        this.log(
          `New workflow: ${workflow.repository.owner}/${workflow.repository.name} - ${workflow.workflowName} #${workflow.runNumber}`,
          "event",
        );
      } else if (oldWorkflow.status !== workflow.status) {
        // Status changed
        const statusIcon = this.getStatusIcon(
          workflow.status,
          workflow.conclusion,
        );
        this.log(
          `Status change: ${workflow.workflowName} #${workflow.runNumber}: ${oldWorkflow.status} → ${workflow.status} ${statusIcon}`,
          "event",
        );
      } else if (
        oldWorkflow.conclusion !== workflow.conclusion &&
        workflow.conclusion
      ) {
        // Conclusion changed
        this.log(
          `Completed: ${workflow.workflowName} #${workflow.runNumber}: ${workflow.conclusion}`,
          "event",
        );
      }
    }

    // Check for removed workflows
    for (const oldWorkflow of this.workflows) {
      if (!newWorkflows.find((w) => w.id === oldWorkflow.id)) {
        this.log(
          `Removed: ${oldWorkflow.workflowName} #${oldWorkflow.runNumber}`,
          "event",
        );
      }
    }
  }
}
