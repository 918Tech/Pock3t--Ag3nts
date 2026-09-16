
# Pocket Agents OS – Day 1 Stealth Engine & Micro-Ledger

**Author:** Matthew Blake Ward  
**Organization:** 918 Technologies  
**Target Hardware:** ESP32-2432S028R (Cheap Yellow Display / CYD)  
**License:** MIT  

---

## Overview

**Pocket Agents OS** is an autonomous, serverless hardware ecosystem for ESP32 devices. Combining a zero-prompt ESP-NOW stealth encounter loop with an on-device cryptographic micro-ledger, Pocket Agents allows hardware nodes to discover each other, resolve deterministic battles, and trade skills passively in physical space.

---

## Key Features

* **Zero-Prompt ESP-NOW Stealth Engine:** Background peer discovery, probing, and atomic skill transfers operating at 2.4 GHz without requiring manual network pairing or active screen interaction.
* **Double-Buffered Cybernetic UI:** Built on LovyanGFX for 320x240 ILI9341 display drivers, rendering a 16-bit RGB565 high-fps terminal layout (`918 TECH [PRESENTS]`).
* **Proof-of-Encounter (PoE) Micro-Ledger:** A tamper-evident, dual-signature DAG micro-ledger preventing skill cloning across NVS resets through localized peer witness validation.
* **Zero-Infrastructure Distribution:** Fully flashable via Web Serial directly from Chrome/Edge browsers with zero local toolchain dependencies.

---

## Hardware Specifications

| Component | Specification |
| :--- | :--- |
| **MCU** | ESP32-D0WDQ6 (240 MHz Dual-Core, 520 KB SRAM) |
| **Display** | 2.8" ILI9341 TFT (320x240 Resolution, SPI Interface) |
| **Touch Controller** | XPT2046 Resistive Touch Controller |
| **Wireless Protocols** | ESP-NOW (Peer-to-Peer 2.4 GHz) + Wi-Fi STA |
| **Storage** | Non-Volatile Storage (NVS) Ring Buffer + Onboard MicroSD Slot |

---

## Repository Structure

```text
├── firmware/
│   ├── include/
│   │   ├── theme.h          # Cybernetic RGB565 palette definitions
│   │   ├── system_engine.h  # Core state machine & ESP-NOW callbacks
│   │   └── micro_ledger.h   # Block data structures & ECDSA validation
│   └── src/
│       ├── main.cpp         # System initialization & main event loop
│       └── ui_engine.cpp    # LovyanGFX sprite buffer & component layout
├── docs/
│   ├── protocol_spec.md     # ESP-NOW stealth wire frame definitions
│   └── UI_MOCKUPS.md        # Pixel layout specifications & touch hitboxes
├── flasher/
│   └── index.html           # Web Serial browser flash tool (GitHub Pages)
└── README.md
