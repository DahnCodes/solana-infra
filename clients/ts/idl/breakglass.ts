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
            "The protocol admin (can be a Squads vault PDA signing via the multisig)."
          ],
          "signer": true
        },
        {
          "name": "protectedProgram"
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
    }
  ],
  "accounts": [
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
    }
  ],
  "types": [
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
