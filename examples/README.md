# Sample setups

## factory.board.yaml

This file is a sample `factory.yaml` with a `board` block. The block tells the factory what an item and a queue row can hold.

- `states` lists the states of an item. `in_progress` and `closed` name two of them.
- `fields` lists the fields of the owner. A field with the target `item` belongs to an item. A field with the target `row` belongs to a queue row.
- `release` is a flag on a queue row.
- `worker_field` names the item field that holds the id of a worker.

To use the sample, copy the `board` block into the `factory.yaml` of your factory. Keep the other keys of your file as they are.

Without a `board` block, the factory has no item states and no owner fields. It can not add an item, close an item or set the state of an item.

The test `test/unit/examples.test.ts` loads this file through the real config schema.
