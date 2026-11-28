/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/breakglass.json`.
 */
export type Breakglass = {
  "address": "AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB",
  "metadata": {
    "name": "breakglass",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Breakglass: emergency circuit breaker and outflow gate for Solana protocols"
  },
  "instructions": [
    {
      "name": "cancelConfig",
      "docs": [
        "The admin cancels a pending change. Phase 4."
      ],
      "discriminator": [
        91,
        124,
        207,
        75,
        179,
        108,
        227,
        13
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pending"
          ]
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  102,
                  103,
                  99,
                  104,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "pending.id",
                "account": "pendingConfig"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "checkOutflow",
      "docs": [
        "The outflow gate. CPI from the protected program's gate PDA. Returns",
        "Allow or Hold; a paused scope fails with ScopePaused. Phase 2."
      ],
      "discriminator": [
        15,
        255,
        137,
        136,
        164,
        56,
        232,
        174
      ],
      "accounts": [
        {
          "name": "gateSigner",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pauseState",
            "flowLimiter"
          ]
        },
        {
          "name": "pauseState",
          "docs": [
            "Writable for the auto-trip on a cap breach."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "flowLimiter",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "flow_limiter.mint",
                "account": "flowLimiter"
              }
            ]
          }
        },
        {
          "name": "vault",
          "relations": [
            "flowLimiter"
          ]
        },
        {
          "name": "hold",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "scope",
          "type": "u8"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "owner",
          "type": "pubkey"
        },
        {
          "name": "holdNonce",
          "type": "u64"
        }
      ],
      "returns": {
        "defined": {
          "name": "decision"
        }
      }
    },
    {
      "name": "checkScope",
      "docs": [
        "Read-only gate for non-outflow instructions: fails if `scope` is paused. Phase 0/1."
      ],
      "discriminator": [
        12,
        18,
        91,
        186,
        116,
        241,
        53,
        20
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pauseState"
          ]
        },
        {
          "name": "pauseState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "scope",
          "type": "u8"
        }
      ]
    },
    {
      "name": "claimHeld",
      "docs": [
        "Claim a held withdrawal after `release_at`. CPI from the protected",
        "program, signed by the owner. Returns Allow or Hold. Phase 2."
      ],
      "discriminator": [
        233,
        137,
        232,
        163,
        130,
        51,
        68,
        151
      ],
      "accounts": [
        {
          "name": "gateSigner",
          "signer": true
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "hold"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pauseState",
            "flowLimiter",
            "hold"
          ]
        },
        {
          "name": "pauseState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "flowLimiter",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "flow_limiter.mint",
                "account": "flowLimiter"
              }
            ]
          }
        },
        {
          "name": "vault",
          "relations": [
            "flowLimiter"
          ]
        },
        {
          "name": "hold",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "hold.nonce",
                "account": "pendingWithdrawal"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [],
      "returns": {
        "defined": {
          "name": "decision"
        }
      }
    },
    {
      "name": "executeConfig",
      "docs": [
        "Anyone runs a pending change after its timelock, unless vetoed or cancelled. Phase 4."
      ],
      "discriminator": [
        189,
        36,
        99,
        231,
        117,
        10,
        8,
        134
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pending"
          ]
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  102,
                  103,
                  99,
                  104,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "pending.id",
                "account": "pendingConfig"
              }
            ]
          }
        },
        {
          "name": "flowLimiter",
          "writable": true,
          "optional": true
        },
        {
          "name": "hold",
          "writable": true,
          "optional": true
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "freezeHeld",
      "docs": [
        "Guardian (or admin) freezes a queued hold. Phase 2."
      ],
      "discriminator": [
        187,
        101,
        233,
        227,
        137,
        207,
        85,
        89
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "hold"
          ]
        },
        {
          "name": "hold",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "hold.owner",
                "account": "pendingWithdrawal"
              },
              {
                "kind": "account",
                "path": "hold.nonce",
                "account": "pendingWithdrawal"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "initFlowLimiter",
      "docs": [
        "Admin creates the outflow limiter for one mint. Phase 2."
      ],
      "discriminator": [
        204,
        255,
        16,
        28,
        146,
        94,
        79,
        171
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "docs": [
            "The protocol's vault token account for `mint`."
          ]
        },
        {
          "name": "flowLimiter",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initFlowLimiterArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initializeConfig",
      "docs": [
        "Register a protected program with Breakglass. Phase 0."
      ],
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "admin",
          "docs": [
            "It doesn't sign here: the upgrade authority below authorizes the",
            "registration, so a multisig vault can be named admin directly."
          ]
        },
        {
          "name": "upgradeAuthority",
          "docs": [
            "The protected program's upgrade authority. Only it can register the",
            "program, so nobody can squat a protocol's config PDA and become its admin."
          ],
          "signer": true
        },
        {
          "name": "protectedProgram"
        },
        {
          "name": "protectedProgramData",
          "docs": [
            "The protected program's ProgramData (BPF upgradeable loader). Immutable",
            "or non-upgradeable programs can't be registered (fail closed)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "protectedProgram"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                2,
                168,
                246,
                145,
                78,
                136,
                161,
                176,
                226,
                16,
                21,
                62,
                247,
                99,
                174,
                43,
                0,
                194,
                185,
                61,
                22,
                193,
                36,
                210,
                192,
                83,
                122,
                16,
                4,
                128,
                0,
                0
              ]
            }
          }
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "protectedProgram"
              }
            ]
          }
        },
        {
          "name": "pauseState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initConfigArgs"
            }
          }
        }
      ]
    },
    {
      "name": "pause",
      "docs": [
        "Pause `scopes` (bitmask) for `duration` seconds. Guardian: bounded by the",
        "max duration, cooldown and budget. Admin: unbounded. Phase 1."
      ],
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pauseState"
          ]
        },
        {
          "name": "pauseState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "guardianLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "scopes",
          "type": "u64"
        },
        {
          "name": "duration",
          "type": "i64"
        },
        {
          "name": "reason",
          "type": "u16"
        }
      ]
    },
    {
      "name": "proposeConfig",
      "docs": [
        "Admin queues a timelocked change (raise limits, add a guardian, set",
        "admin, release a hold, change policy). Phase 4."
      ],
      "discriminator": [
        163,
        247,
        238,
        160,
        236,
        129,
        153,
        160
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          }
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  102,
                  103,
                  99,
                  104,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "config.next_change_id",
                "account": "protocolConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "action",
          "type": {
            "defined": {
              "name": "configAction"
            }
          }
        }
      ]
    },
    {
      "name": "rejectHeld",
      "docs": [
        "Admin rejects a hold, through the protected program. Phase 2."
      ],
      "discriminator": [
        164,
        157,
        160,
        206,
        47,
        154,
        132,
        28
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "gateSigner",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "hold"
          ]
        },
        {
          "name": "hold",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "hold.owner",
                "account": "pendingWithdrawal"
              },
              {
                "kind": "account",
                "path": "hold.nonce",
                "account": "pendingWithdrawal"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "removeGuardian",
      "docs": [
        "Admin removes a guardian, effective immediately. Phase 1."
      ],
      "discriminator": [
        72,
        117,
        160,
        244,
        155,
        185,
        71,
        18
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "guardian",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "renewPause",
      "docs": [
        "Extend running pauses by the guardian max duration. Guardian: own pauses,",
        "up to the renew cap. Admin: any pause, no cap. Phase 1."
      ],
      "discriminator": [
        8,
        149,
        118,
        223,
        214,
        95,
        247,
        83
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pauseState"
          ]
        },
        {
          "name": "pauseState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "guardianLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "scopes",
          "type": "u64"
        }
      ]
    },
    {
      "name": "tightenLimits",
      "docs": [
        "The admin tightens a limiter immediately (no timelock). Phase 4."
      ],
      "discriminator": [
        64,
        255,
        167,
        150,
        242,
        33,
        143,
        144
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "flowLimiter"
          ]
        },
        {
          "name": "flowLimiter",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "flow_limiter.mint",
                "account": "flowLimiter"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "limiterParams"
            }
          }
        }
      ]
    },
    {
      "name": "unpause",
      "docs": [
        "Lift pauses early. Admin: any. Guardian: only its own. Phase 1."
      ],
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pauseState"
          ]
        },
        {
          "name": "pauseState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "scopes",
          "type": "u64"
        }
      ]
    },
    {
      "name": "vetoConfig",
      "docs": [
        "A guardian vetoes a pending change. Phase 4."
      ],
      "discriminator": [
        222,
        91,
        78,
        34,
        15,
        41,
        55,
        161
      ],
      "accounts": [
        {
          "name": "guardian",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.protected_program",
                "account": "protocolConfig"
              }
            ]
          },
          "relations": [
            "pending"
          ]
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  102,
                  103,
                  99,
                  104,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "pending.id",
                "account": "pendingConfig"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "flowLimiter",
      "discriminator": [
        161,
        229,
        183,
        240,
        64,
        74,
        254,
        168
      ]
    },
    {
      "name": "guardianLedger",
      "discriminator": [
        85,
        30,
        190,
        99,
        66,
        99,
        240,
        19
      ]
    },
    {
      "name": "pauseState",
      "discriminator": [
        21,
        123,
        173,
        77,
        60,
        203,
        197,
        145
      ]
    },
    {
      "name": "pendingConfig",
      "discriminator": [
        109,
        48,
        178,
        191,
        125,
        67,
        26,
        70
      ]
    },
    {
      "name": "pendingWithdrawal",
      "discriminator": [
        61,
        103,
        179,
        177,
        148,
        199,
        63,
        171
      ]
    },
    {
      "name": "protocolConfig",
      "discriminator": [
        207,
        91,
        250,
        28,
        152,
        179,
        215,
        209
      ]
    }
  ],
  "events": [
    {
      "name": "configChangeCancelled",
      "discriminator": [
        66,
        48,
        129,
        141,
        104,
        33,
        113,
        2
      ]
    },
    {
      "name": "configChangeExecuted",
      "discriminator": [
        247,
        53,
        112,
        244,
        231,
        218,
        42,
        95
      ]
    },
    {
      "name": "configChangeProposed",
      "discriminator": [
        57,
        212,
        96,
        3,
        9,
        29,
        225,
        198
      ]
    },
    {
      "name": "configChangeVetoed",
      "discriminator": [
        99,
        95,
        172,
        245,
        178,
        22,
        110,
        47
      ]
    },
    {
      "name": "configInitialized",
      "discriminator": [
        181,
        49,
        200,
        156,
        19,
        167,
        178,
        91
      ]
    },
    {
      "name": "guardianRemoved",
      "discriminator": [
        225,
        27,
        117,
        56,
        241,
        196,
        5,
        56
      ]
    },
    {
      "name": "holdFrozen",
      "discriminator": [
        109,
        125,
        222,
        166,
        136,
        63,
        153,
        164
      ]
    },
    {
      "name": "holdResolved",
      "discriminator": [
        243,
        108,
        229,
        108,
        98,
        118,
        141,
        102
      ]
    },
    {
      "name": "largeWithdrawalQueued",
      "discriminator": [
        149,
        238,
        7,
        241,
        126,
        190,
        125,
        92
      ]
    },
    {
      "name": "limitHoldQueued",
      "discriminator": [
        53,
        54,
        6,
        136,
        86,
        28,
        141,
        239
      ]
    },
    {
      "name": "limitTripped",
      "discriminator": [
        24,
        217,
        78,
        140,
        193,
        240,
        108,
        231
      ]
    },
    {
      "name": "limitsTightened",
      "discriminator": [
        223,
        134,
        148,
        84,
        89,
        74,
        42,
        133
      ]
    },
    {
      "name": "outflowRecorded",
      "discriminator": [
        136,
        136,
        230,
        222,
        156,
        138,
        74,
        131
      ]
    },
    {
      "name": "pauseRenewed",
      "discriminator": [
        229,
        67,
        172,
        75,
        243,
        249,
        25,
        152
      ]
    },
    {
      "name": "paused",
      "discriminator": [
        172,
        248,
        5,
        253,
        49,
        255,
        255,
        232
      ]
    },
    {
      "name": "unpaused",
      "discriminator": [
        156,
        150,
        47,
        174,
        120,
        216,
        93,
        117
      ]
    },
    {
      "name": "withdrawalScreenQueued",
      "discriminator": [
        6,
        149,
        13,
        50,
        114,
        195,
        118,
        2
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "scopePaused",
      "msg": "Scope is paused"
    },
    {
      "code": 6001,
      "name": "invalidScope",
      "msg": "Scope id out of range (0..64)"
    },
    {
      "code": 6002,
      "name": "scopeUnpausable",
      "msg": "Scope is marked unpausable"
    },
    {
      "code": 6003,
      "name": "unauthorized",
      "msg": "Signer is not allowed to perform this action"
    },
    {
      "code": 6004,
      "name": "tooManyGuardians",
      "msg": "Too many guardians"
    },
    {
      "code": 6005,
      "name": "pauseTooLong",
      "msg": "Pause duration exceeds the guardian maximum"
    },
    {
      "code": 6006,
      "name": "renewCapReached",
      "msg": "Guardian renewal cap reached; admin must extend"
    },
    {
      "code": 6007,
      "name": "guardianCooldown",
      "msg": "Guardian is in cooldown"
    },
    {
      "code": 6008,
      "name": "pauseBudgetExhausted",
      "msg": "Guardian pause budget for this period is used up"
    },
    {
      "code": 6009,
      "name": "tooManyActivePauses",
      "msg": "Too many active pauses"
    },
    {
      "code": 6010,
      "name": "holdNotReleased",
      "msg": "Held withdrawal is not released yet"
    },
    {
      "code": 6011,
      "name": "holdFrozen",
      "msg": "Held withdrawal is frozen"
    },
    {
      "code": 6012,
      "name": "holdInvalidState",
      "msg": "Held withdrawal is not in a claimable state"
    },
    {
      "code": 6013,
      "name": "invalidCaller",
      "msg": "Caller is not the registered protected program"
    },
    {
      "code": 6014,
      "name": "timelockActive",
      "msg": "Timelock is still active"
    },
    {
      "code": 6015,
      "name": "invalidTimelock",
      "msg": "Timelock value out of allowed range"
    },
    {
      "code": 6016,
      "name": "vetoed",
      "msg": "Pending change was vetoed"
    },
    {
      "code": 6017,
      "name": "invariantViolated",
      "msg": "Protocol invariant violated"
    },
    {
      "code": 6018,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6019,
      "name": "notExecutable",
      "msg": "Account is not executable"
    },
    {
      "code": 6020,
      "name": "scopeNotPaused",
      "msg": "Scope is not paused"
    },
    {
      "code": 6021,
      "name": "invalidDuration",
      "msg": "Pause duration must be positive"
    },
    {
      "code": 6022,
      "name": "guardianNotFound",
      "msg": "Key is not a guardian of this config"
    },
    {
      "code": 6023,
      "name": "invalidLimiterConfig",
      "msg": "Flow limiter parameters out of range"
    },
    {
      "code": 6024,
      "name": "wrongVault",
      "msg": "Vault token account does not match the flow limiter"
    },
    {
      "code": 6025,
      "name": "wrongHold",
      "msg": "Hold account does not match its seeds, owner, mint or limiter"
    },
    {
      "code": 6026,
      "name": "notTightening",
      "msg": "Change loosens a limit; propose it through the timelock"
    },
    {
      "code": 6027,
      "name": "duplicateGuardian",
      "msg": "Key is already a guardian"
    },
    {
      "code": 6028,
      "name": "changeClosed",
      "msg": "Pending change was already executed or cancelled"
    },
    {
      "code": 6029,
      "name": "wrongChangeAccounts",
      "msg": "Accounts passed do not match the pending change"
    },
    {
      "code": 6030,
      "name": "invalidPolicy",
      "msg": "Pause policy values out of range"
    }
  ],
  "types": [
    {
      "name": "configAction",
      "docs": [
        "A timelocked change. Anything that loosens protection or releases funds."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "raiseLimits",
            "fields": [
              {
                "name": "mint",
                "type": "pubkey"
              },
              {
                "name": "params",
                "type": {
                  "defined": {
                    "name": "limiterParams"
                  }
                }
              }
            ]
          },
          {
            "name": "addGuardian",
            "fields": [
              {
                "name": "guardian",
                "type": "pubkey"
              }
            ]
          },
          {
            "name": "setAdmin",
            "fields": [
              {
                "name": "admin",
                "type": "pubkey"
              }
            ]
          },
          {
            "name": "releaseHeld",
            "fields": [
              {
                "name": "hold",
                "type": "pubkey"
              }
            ]
          },
          {
            "name": "changePolicy",
            "fields": [
              {
                "name": "policy",
                "type": {
                  "defined": {
                    "name": "pausePolicy"
                  }
                }
              },
              {
                "name": "unpausableMask",
                "type": "u64"
              },
              {
                "name": "timelockSecs",
                "type": "i64"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "configChangeCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "change",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "configChangeExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "change",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "configChangeProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "change",
            "type": "pubkey"
          },
          {
            "name": "actionKind",
            "type": "u8"
          },
          {
            "name": "executableAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "configChangeVetoed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "change",
            "type": "pubkey"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "configInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "protectedProgram",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "guardians",
            "type": {
              "vec": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "decision",
      "docs": [
        "What `check_outflow` / `claim_held` return (Anchor return data).",
        "Deny never comes back as a value: Breakglass fails with `ScopePaused`",
        "instead, so the error is attributed to Breakglass. The variant stays for SDK",
        "callers that want an exhaustive match."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "allow"
          },
          {
            "name": "hold"
          },
          {
            "name": "deny"
          }
        ]
      }
    },
    {
      "name": "flowLimiter",
      "docs": [
        "PDA [\"flow\", config, mint]. One per mint, so write locks stay per asset.",
        "Window math lives in `limiter.rs`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "The protocol's vault token account for `mint`. Its balance sizes the bps cap."
            ],
            "type": "pubkey"
          },
          {
            "name": "scope",
            "docs": [
              "The outflow scope this limiter gates (and auto-trips on a cap breach)."
            ],
            "type": "u8"
          },
          {
            "name": "windowSecs",
            "type": "i64"
          },
          {
            "name": "capAbsolute",
            "type": "u64"
          },
          {
            "name": "capBpsOfVault",
            "docs": [
              "0 = no balance-based cap."
            ],
            "type": "u16"
          },
          {
            "name": "buckets",
            "docs": [
              "Ring of outflow sums; bucket width = ceil(window_secs / 11), so the 12",
              "buckets always cover at least `window_secs` (never under-counts)."
            ],
            "type": {
              "array": [
                "u64",
                12
              ]
            }
          },
          {
            "name": "bucketStart",
            "docs": [
              "Start time of the newest bucket."
            ],
            "type": "i64"
          },
          {
            "name": "largeThreshold",
            "type": "u64"
          },
          {
            "name": "largeThresholdBps",
            "docs": [
              "0 = threshold is `large_threshold` only; else min(large_threshold, bps x balance)."
            ],
            "type": "u16"
          },
          {
            "name": "holdSecs",
            "type": "i64"
          },
          {
            "name": "autoTripSecs",
            "type": "i64"
          },
          {
            "name": "instantAllowance",
            "docs": [
              "Zero-loss mode (Phase 3): amount per call that may skip screening (0 = screen everything)."
            ],
            "type": "u64"
          },
          {
            "name": "screenSecs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "guardianLedger",
      "docs": [
        "PDA [\"gledger\", config, guardian]. Created on the signer's first `pause` or `renew_pause`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "periodStart",
            "type": "i64"
          },
          {
            "name": "pauseSecsUsed",
            "type": "i64"
          },
          {
            "name": "lastPauseEnd",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "guardianRemoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdFrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "hold",
            "type": "pubkey"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdKind",
      "docs": [
        "Why a withdrawal was held."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "large"
          },
          {
            "name": "limit"
          },
          {
            "name": "screen"
          }
        ]
      }
    },
    {
      "name": "holdResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "hold",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "docs": [
              "0 = claimed, 1 = released, 2 = rejected"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holdStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "queued"
          },
          {
            "name": "frozen"
          },
          {
            "name": "released"
          },
          {
            "name": "rejected"
          },
          {
            "name": "claimed"
          }
        ]
      }
    },
    {
      "name": "initConfigArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "guardians",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "unpausableMask",
            "type": "u64"
          },
          {
            "name": "timelockSecs",
            "docs": [
              "None = DEFAULT_TIMELOCK_SECS. Must be within [MIN_TIMELOCK_SECS, MAX_TIMELOCK_SECS]."
            ],
            "type": {
              "option": "i64"
            }
          }
        ]
      }
    },
    {
      "name": "initFlowLimiterArgs",
      "docs": [
        "Limiter parameters. `None` takes the spec default where one exists."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "scope",
            "docs": [
              "The outflow scope this limiter gates (the scope `check_outflow` must be called with)."
            ],
            "type": "u8"
          },
          {
            "name": "windowSecs",
            "docs": [
              "None = DEFAULT_WINDOW_SECS. Must be >= 12."
            ],
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "capAbsolute",
            "docs": [
              "Required, > 0."
            ],
            "type": "u64"
          },
          {
            "name": "capBpsOfVault",
            "docs": [
              "0 = no balance-based cap. Max 10_000."
            ],
            "type": "u16"
          },
          {
            "name": "largeThreshold",
            "docs": [
              "Required. Withdrawals >= this are held for `hold_secs`."
            ],
            "type": "u64"
          },
          {
            "name": "largeThresholdBps",
            "docs": [
              "0 = absolute threshold only. Max 10_000."
            ],
            "type": "u16"
          },
          {
            "name": "holdSecs",
            "docs": [
              "None = DEFAULT_HOLD_SECS."
            ],
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "autoTripSecs",
            "docs": [
              "None = config.policy.auto_trip_secs."
            ],
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "instantAllowance",
            "docs": [
              "None = DEFAULT_INSTANT_ALLOWANCE (no screening). Used from Phase 3."
            ],
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "screenSecs",
            "docs": [
              "None = DEFAULT_SCREEN_SECS. Used from Phase 3."
            ],
            "type": {
              "option": "i64"
            }
          }
        ]
      }
    },
    {
      "name": "largeWithdrawalQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "hold",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "releaseAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "limitHoldQueued",
      "docs": [
        "A withdrawal that would have crossed the window cap was held (and the scope",
        "auto-tripped; `LimitTripped` and `Paused` are emitted with it)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "hold",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "releaseAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "limitTripped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "scope",
            "type": "u8"
          },
          {
            "name": "windowTotal",
            "type": "u64"
          },
          {
            "name": "windowCap",
            "type": "u64"
          },
          {
            "name": "pausedUntil",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "limiterParams",
      "docs": [
        "Every FlowLimiter setting an admin can change (after `init_flow_limiter`).",
        "Loosening goes through `propose_config(RaiseLimits)`; a change where every",
        "field is equal or stricter applies at once through `tighten_limits`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "windowSecs",
            "type": "i64"
          },
          {
            "name": "capAbsolute",
            "type": "u64"
          },
          {
            "name": "capBpsOfVault",
            "type": "u16"
          },
          {
            "name": "largeThreshold",
            "type": "u64"
          },
          {
            "name": "largeThresholdBps",
            "type": "u16"
          },
          {
            "name": "holdSecs",
            "type": "i64"
          },
          {
            "name": "autoTripSecs",
            "type": "i64"
          },
          {
            "name": "instantAllowance",
            "type": "u64"
          },
          {
            "name": "screenSecs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "limitsTightened",
      "docs": [
        "The admin tightened a limiter immediately (no timelock needed)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "flowLimiter",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "outflowRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "windowTotal",
            "type": "u64"
          },
          {
            "name": "windowCap",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "pauseKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "guardian"
          },
          {
            "name": "autoTrip"
          },
          {
            "name": "admin"
          }
        ]
      }
    },
    {
      "name": "pausePolicy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxGuardianPauseSecs",
            "type": "i64"
          },
          {
            "name": "maxRenewals",
            "type": "u8"
          },
          {
            "name": "cooldownSecs",
            "type": "i64"
          },
          {
            "name": "budgetSecsPerPeriod",
            "type": "i64"
          },
          {
            "name": "budgetPeriodSecs",
            "type": "i64"
          },
          {
            "name": "autoTripSecs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pauseRenewed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "scopesMask",
            "type": "u64"
          },
          {
            "name": "pausedUntil",
            "type": "i64"
          },
          {
            "name": "by",
            "type": "pubkey"
          },
          {
            "name": "renewals",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pauseState",
      "docs": [
        "PDA [\"pause\", config]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "active",
            "type": {
              "vec": {
                "defined": {
                  "name": "scopePause"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "paused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "scopesMask",
            "type": "u64"
          },
          {
            "name": "pausedUntil",
            "type": "i64"
          },
          {
            "name": "by",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "pendingConfig",
      "docs": [
        "PDA [\"cfgchg\", config, id]. Created by `propose_config`; executable by",
        "anyone at `executable_at` unless vetoed (guardian) or cancelled (admin)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "action",
            "type": {
              "defined": {
                "name": "configAction"
              }
            }
          },
          {
            "name": "proposedBy",
            "type": "pubkey"
          },
          {
            "name": "proposedAt",
            "type": "i64"
          },
          {
            "name": "executableAt",
            "type": "i64"
          },
          {
            "name": "vetoed",
            "type": "bool"
          },
          {
            "name": "executed",
            "type": "bool"
          },
          {
            "name": "cancelled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "pendingWithdrawal",
      "docs": [
        "PDA [\"hold\", config, owner, nonce]. Created by `check_outflow` on Hold."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "releaseAt",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "holdStatus"
              }
            }
          },
          {
            "name": "scope",
            "type": "u8"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "holdKind"
              }
            }
          }
        ]
      }
    },
    {
      "name": "protocolConfig",
      "docs": [
        "PDA [\"config\", protected_program]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "protectedProgram",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "docs": [
              "Usually a Squads multisig vault PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "guardians",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "unpausableMask",
            "docs": [
              "Scopes that can never be paused (exit-safety paths such as repay)."
            ],
            "type": "u64"
          },
          {
            "name": "policy",
            "type": {
              "defined": {
                "name": "pausePolicy"
              }
            }
          },
          {
            "name": "timelockSecs",
            "type": "i64"
          },
          {
            "name": "nextChangeId",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "scopePause",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "scope",
            "type": "u8"
          },
          {
            "name": "pausedUntil",
            "type": "i64"
          },
          {
            "name": "pausedBy",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "pauseKind"
              }
            }
          },
          {
            "name": "renewals",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "unpaused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "scopesMask",
            "type": "u64"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "withdrawalScreenQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "hold",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "releaseAt",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
