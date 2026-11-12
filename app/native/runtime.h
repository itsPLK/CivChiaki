#ifndef CIVCHIAKI_RUNTIME_H
#define CIVCHIAKI_RUNTIME_H
#include <stdint.h>
int cc_runtime_pump(double budget_ms);
int cc_runtime_tasks(void);
int cc_runtime_current_task(void);
void cc_yield_ms(int milliseconds);
void cc_runtime_checkpoint(void);
#endif
